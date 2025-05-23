import { DurableObject } from "cloudflare:workers";

// starting => we called start() and init the monitor promise
// running => container returned healthy on the endpoint
// unhealthy => container is unhealthy (returning not OK status codes)
// stopped => container is stopped (finished running)
// failed => container failed to run and it won't try to run again, unless called 'start' again
//
// As written class Container will only use running and stopped. If you define a healthcheck()
// function that returns ContainerState, it will call it in it's alarm and update the state to the result
// of that call.
export type ContainerState =
  | "starting"
  | "running"
  | "unhealthy"
  | "stopped"
  | "failed"
  | "unknown";

async function wrap<T, E = Error>(
  fn: Promise<T>,
): Promise<[T, null] | [null, E]> {
  return fn
    .then((data) => [data, null] as [T, null])
    .catch((err) => [null, err as unknown as E] as [null, E]);
}

function isNotListeningError(err: Error): boolean {
  return err.message.includes("the container is not listening");
}

function noContainerYetError(err: Error): boolean {
  return err.message.includes("there is no container instance");
}

function wait(ms: number): Promise<unknown> {
  return new Promise((res) => setTimeout(res, ms));
}

export class CommonContainer extends DurableObject<Env> {
  container: globalThis.Container;
  monitor?: Promise<unknown>;

  constructor(ctx: DurableObjectState, env: Env) {
    if (ctx.container === undefined) {
      throw new Error("container is not defined");
    }

    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.container = ctx.container;
    this.ctx.blockConcurrencyWhile(async () => {
      if (this.container.running) {
        if (this.monitor === undefined) {
          this.monitor = this.container.monitor();
          this.handleMonitorPromise(this.monitor);
        }
      }

      // if no alarm, trigger ASAP
      await this.setAlarm(Date.now());
    });
  }
  async state(): Promise<ContainerState> {
    const state = (await this.ctx.storage.get("state")) ?? "unknown";
    return state;
  }

  async stateTx(cb: (state: ContainerState) => Promise<unknown>) {
    return await this.ctx.blockConcurrencyWhile(async () => {
      const s = await this.state();
      await cb(s);
    });
  }

  public async preStateChange(
    current: ContainerState,
    newState: ContainerState,
  ) {
    return;
  }

  public async postStateChange(old: ContainerState, current: ContainerState) {
    // this is a no-op
    // implement it for your own behavior
    return;
  }

  private async setState(state: ContainerState) {
    console.log("Setting container state", state);
    const oldState = await this.ctx.storage.get("state");
    await this.preStateChange(oldState, state);
    await this.ctx.storage.put("state", state);
    await this.ctx.storage.sync();
    await this.postStateChange(oldState, state);
  }

  async setAlarm(value = Date.now() + 500) {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null) {
      await this.ctx.storage.setAlarm(value);
      await this.ctx.storage.sync();
    }
  }

  async alarm() {
    try {
      await this.stateTx(async (state) => {
        console.log("Current container state:", state);
        const maybeHealthCheck = (this as any).healthCheck;

        if (typeof maybeHealthcheck === "function") {
          const [result, err] = await wrap(maybeHealthCheck());
          if (err !== null) {
            console.error(
              "Received an internal error from healthCheck:",
              err.message,
            );
            if (state !== "starting") {
              await this.setState("failed");
            }

            return;
          }

          if (typeof result !== "string") {
            console.warn(
              "Container is unhealthy because it returned a ",
              result.status,
            );

            // consume text stream
            await wrap(result.text());

            await this.setState("unhealthy");
            return;
          }

          if (result === "ok") {
            await this.setState("running");
            return;
          }

          if (result == "not_listening" || result == "no_container_yet") {
            await this.setState("starting");
            return;
          }

          console.error("unknown result:", result);
        } else {
          await this.setState(state);
          console.log("No healthcheck function defined.");
        }
      });
    } catch (error) {
      console.error("error during alarm: ", error, error.message);
    } finally {
      await this.setAlarm();
    }
  }

  handleMonitorPromise(monitor: Promise<unknown>) {
    monitor
      .then(async () => {
        await this.stateTx(async (state) => {
          if (state === "running" || state == "unhealthy") {
            await this.setState("stopped");
            console.log(`Container stopped from state ${state}`);
            return;
          }

          if (state === "starting") {
            console.log(
              "Container was starting, and monitor resolved, we might have had an exception, retrying later",
            );
            this.handleMonitorPromise(this.monitor);
            return;
          }

          if (state === "failed") {
            console.log(
              "Container was marked as failed, but we resolved monitor successfully",
            );
          }
        });
      })
      .catch(async (err) => {
        console.error(`Monitor exited with an error: ${err.message}`);
        await this.setState("failed");
      });
  }

  // 'start' will start the container, and it will make sure it runs until the end
  async start(containerStart?: ContainerStartupOptions) {
    if (this.container.running) {
      if (this.monitor === undefined) {
        this.monitor = this.container.monitor();
        this.handleMonitorPromise(this.monitor);
      }

      return;
    }

    await this.container.start(containerStart);
    await this.setState("running");
    this.monitor = this.container.monitor();
    this.handleMonitorPromise(this.monitor);
  }

  // This ALWAYS throws an exception because it resets the DO
  async destroy() {
    try {
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
      await this.container.destroy();
    } finally {
      this.ctx.abort();
    }
  }

  public async fetch(request: Request, port = 8080): Promise<Response> {
    return await this.ctx.container
      .getTcpPort(port)
      .fetch(request.url.replace("https://", "http://"), request);
  }
}
