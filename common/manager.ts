import { DurableObject } from "cloudflare:workers";
import type { CommonContainer, ContainerState } from "./container";

export type ContainerInfo = {
  startupOpts: ContainerStartupOptions;
  name: string;
  state: ContainerState;
  bindingName: string;
};

export type ContainerBindingMap = Record<string, DurableObjectNamespace>;

export class CommonContainerManager extends DurableObject<Env> {
  constructor(
    ctx: DurableObjectState,
    env: Env,
    bindings: ContainerBindingMap,
  ) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.bindings = bindings;
    this.setAlarm(Date.now());
  }

  private async getBinding(name: string): DurableObjectNamespace {
    const keys = Object.keys(this.bindings);
    if (name === "") {
      if (keys.length === 0) {
        throw new Error("No container binding provided");
      } else if (keys.length === 1) {
        return this.bindings[keys[0]];
      } else {
        throw new Error(
          "Multiple container bindings present: you must specify a name.",
        );
      }
    } else {
      const binding = this.bindings[name];
      if (!binding) {
        throw new Error(`No container binding found for name: '${name}'`);
      }
      return binding;
    }
  }

  private async getContainerBinding(
    bindingName: string,
    name: string,
  ): DurableObjectStub {
    const binding = await this.getBinding(bindingName);
    const id = binding.idFromName(name);
    return await binding.get(id);
  }
  // launches a newContainer with the given properties
  public async newContainer(
    opts: ContainerStartupOptions,
    name: string,
    bindingName?: string,
  ): Promise<void> {
    const container = await this.getContainerBinding(bindingName, name);

    container.start(opts);
    await this.addContainer(name, opts, bindingName);
  }

  // forwards a request to the named container
  public async requestContainer(
    name: string,
    request: Request,
  ): Promise<Response> {
    const containers = await this.ctx.storage.get("containers");
    const info = containers.filter((c) => c.name === name);
    if (info.length !== 1) {
      throw new Error(`No record found for container: ${name}`);
    }

    const container = await this.getContainerBinding(info[0].bindingName, name);

    return await container.fetch(request);
  }

  // {add,rm}Container handle updating DO storage of it's containers
  public async addContainer(
    name: string,
    opts: ContainerStartupOptions,
    bindingName: string,
  ): Promise<void> {
    let containers = await this.ctx.storage.get("containers");
    if (!containers) {
      containers = [];
    }
    if (!containers.includes(name)) {
      containers.push({
        name: name,
        startupOpts: opts,
        state: "starting",
        bindingName: bindingName,
      });
      await this.ctx.storage.put("containers", containers);
      await this.ctx.storage.sync();
    }
  }

  public async rmContainer(name: string): Promise<boolean> {
    let containers = await this.ctx.storage.get<ContainerInfo[]>("containers");
    if (!containers || containers.length === 0) {
      return false;
    }
    const beforeLength = containers.length;
    containers = containers.filter((d) => d !== name);
    if (containers.length !== beforeLength) {
      await this.ctx.storage.put("containers", containers);
      return true;
    }
    return false;
  }

  // returns info on the containers this DO is managing
  public async listContainers(): Promise<Array<ContainerInfo>> {
    const list = await this.ctx.storage.get("containers");
    if (!list) {
      return [];
    }
    return list;
  }

  public async updateContainerStates(): Promise<void> {
    this.ctx.blockConcurrencyWhile(async () => {
      const containers =
        await this.ctx.storage.get<ContainerInfo[]>("containers");
      const updated: ContainerInfo[] = [];
      const removals: ContainerInfo[] = [];
      for (const container of containers) {
        const c = await this.getContainerBinding(
          container.bindingName,
          container.name,
        );
        const state = await c.state();

        if (this.isTerminalState(state)) {
          //decide if we should remove or not
          const remove = this.handleTerminalState(c);
          if (remove) {
            removals.push(container);
            continue;
          }
        }
        container.state = state;
        updated.push(container);
      }
      for (const rm in removals) {
        await this.rmContainer(rm.name);
      }
      await this.ctx.storage.put("containers", updated);
      await this.ctx.storage.sync();
    });
  }

  async setAlarm(value = Date.now() + 1000) {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null) {
      await this.ctx.storage.setAlarm(value);
      await this.ctx.storage.sync();
    }
  }

  async alarm() {
    try {
      await this.updateContainerStates();
    } finally {
      await this.setAlarm();
    }
  }

  isTerminalState(state: ContainerState): boolean {
    return state === "stopped" || state === "failed";
  }

  // Default behavior destroys and removes container on terminal state
  async handleTerminalState(container: Container): boolean {
    container.destroy();
    return true;
  }
}
