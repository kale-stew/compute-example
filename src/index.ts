import { z } from "zod";
import { CommonContainerManager } from "../common/manager";
import { CommonContainer } from "../common/container";
import type { ContainerState } from "../common/container";
import type { ContainerBindingMap } from "../common/manager";

export class MyContainer extends CommonContainer {
  // healthCheck returns 'ok' when the container returned
  // in the port returned a successful status code.
  // It will return a Response object when the status code is not ok.
  // It will return a known error enum if the container is not ready yet.
  public override async healthCheck(
    portNumber = 8080,
  ): Promise<"ok" | "not_listening" | "no_container_yet" | Response> {
    const port = this.container.getTcpPort(portNumber);
    const [res, err] = await wrap(
      port.fetch(new Request("http://container/_health")),
    );
    if (err !== null) {
      if (isNotListeningError(err)) {
        return "not_listening";
      }

      if (noContainerYetError(err)) {
        return "no_container_yet";
      }

      throw err;
    }

    if (res.ok) {
      await res.text();
      return "ok";
    }

    // let the end user handle the not ok status code
    return res;
  }
}

// Here we define our 3 classes that simply extend a common base class.
// This is just to give us a target class for the different compute classes we
// defined in our wrangler.jsonc.
//
// We don't in this example but you could define different behavior for each one.
export class MyContainerSmall extends MyContainer {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }
}

export class MyContainerMedium extends MyContainer {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }
}

export class MyContainerLarge extends MyContainer {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }
}

export class MyContainerManager extends CommonContainerManager {
  constructor(ctx: DurableObjectState, env: Env) {
    // The bindingMap we pass into CommonContainerManagers constructor here
    // is what allows us to target a specific binding based on the users
    // requested size.
    const bindingMap: ContainerBindingMap = {
      small: env.CONTAINER_SMALL,
      medium: env.CONTAINER_MEDIUM,
      large: env.CONTAINER_LARGE,
    };
    super(ctx, env, bindingMap);
    this.ctx = ctx;
    this.env = env;
  }

  public override async handleTerminalState(
    container: CommonContainer,
  ): boolean {
    if (c instanceof MyContainer) {
      // I never want my containers to be restarted
      return true;
    } else {
      return super.handleTerminalState(container);
    }
  }
}

// Define a schema for our /start request
const startSchema = z.object({
  name: z.string(),
  envVars: z.record(z.string(), z.string()).optional(),
  entrypoint: z.array(z.string()).optional(),
  enableInternet: z.boolean().optional(),
  size: z.string(),
});

export default {
  async fetch(request, env, ctx): Promise<Response> {
    // Grab our single DO Container manager
    const mid = env.CONTAINER_MANAGER.idFromName("manager");
    const manager = env.CONTAINER_MANAGER.get(mid);
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Assumes requests come with the pattern /container/<job name>
    // where <job name> matches the name the user supplied to /start
    if (pathname.startsWith("/container/")) {
      const parts = pathname.split("/");
      const lastPart = parts.pop();
      return await manager.requestContainer(lastPart, request);
    }

    // Requst our manager to start a new container with the user-supplied options.
    if (pathname.startsWith("/start")) {
      try {
        const raw = await request.text();
        const json = JSON.parse(raw);
        const startOpts = startSchema.parse(json);
        await manager.newContainer(
          {
            env: startOpts.envVars,
            entrypoint: startOpts.entrypoint,
            enableInternet: startOpts.enableInternet,
          },
          startOpts.name,
          startOpts.size,
        );
        return new Response("Container starting");
      } catch (error) {
        console.error("error starting container: ", error);
        return new Response(
          JSON.stringify({
            message: "Error parsing request",
            status: 500,
            statusText: error.message,
            headers: {
              "Content-Type": "application/json",
            },
          }),
        );
      }
    }

    // List the containers that are currently running.
    if (pathname.startsWith("/list")) {
      const runningContainers = await manager.listContainers();
      return new Response(JSON.stringify(runningContainers));
    }

    return new Response("Hello pool world", {
      headers: { "Content-Type": "text/html;charset=UTF-8" },
    });
  },
} satisfies ExportedHandler<Env>;
