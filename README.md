# Compute example

This example shows how you could have multiple classes of compute managed by a single worker + a DO container manager that manages multiple DO container bindings.

## How to deploy

To deploy this example all that is required is the appropriate permission and a call to `pnpm run deploy`.


## Launching a compute job

To launch a compute job with this example you need to make a request like:

```
curl https://<path/to/your/worker>/start \
    -x POST \
    -d '{"name":"my-first-job", "envVars": {"VAR_ONE":"something", "VAR_TWO": "something else"}, "enableInternet": false, "size": "large", "entrypoint": ["/server"] }'
```

This will launch a compute job with the name `my-first-job` with the provided env variables, entrypoint, and compute size selected.

If using the example docker image in the repo, you can check the jobs details by querying the container directly by doing:

```
curl https://<path/to/your/worker>/container/my-first-job
...
Hi, I'm a container running in sin09, SG, which is part of APAC
My env Vars are:
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
CLOUDFLARE_APPLICATION_ID=<application ID>
CLOUDFLARE_COUNTRY_A2=SG
CLOUDFLARE_DEPLOYMENT_ID=<deployment ID>
CLOUDFLARE_LOCATION=sin09
CLOUDFLARE_REGION=APAC
VAR_ONE=something
VAR_TWO=something else
CLOUDFLARE_DURABLE_OBJECT_ID=<DO ID>
HOME=/
I was started with args:
/server
I have 3 cpus
I am shutting down in 100 seconds
```

## How does this work?

### Wrangler configuration

Lets go through the wrangler.jsonc section by section.

```json
	"migrations": [
		{
			"new_sqlite_classes": [
				"MyContainerSmall",
				"MyContainerMedium",
				"MyContainerLarge",
				"MyContainerManager"
			],
			"tag": "v1"
		}
	],
```

Here we are defining our sqlite classes. We have 4, 3 container binding DO's and one manager DO.


```json
	"containers": [
		{
		"name": "small",
		"image": "./Dockerfile",
		"max_instances": 5,
		"configuration" : {
			"vcpu": 1,
			"memory": "1GB"
		},
		"class_name": "MyContainerSmall"

	},
		{
		"name": "medium",
		"image": "./Dockerfile",
		"max_instances": 5,
		"configuration" : {
			"vcpu": 2,
			"memory": "2GB"
		},
		"class_name": "MyContainerMedium"

	},
		{
		"name": "large",
		"image": "./Dockerfile",
		"max_instances": 5,
		"configuration" : {
			"vcpu": 3,
			"memory": "3GB"
		},
		"class_name": "MyContainerLarge"

	}
	],

```

In our array of container bindings we have defined 3 compute sizes: small, medium, and large.
The names are chosen arbitrarily and are used for targeting the correct binding at runtime.
We use the same container image for all 3 but you could use a different image for each one by changing the image argument.

```json
	"durable_objects": {
		"bindings": [
			{
				"class_name": "MyContainerSmall",
				"name": "CONTAINER_SMALL"
			},
			{
				"class_name": "MyContainerMedium",
				"name": "CONTAINER_MEDIUM"
			},
			{
				"class_name": "MyContainerLarge",
				"name": "CONTAINER_LARGE"
			},
			{
				"class_name": "MyContainerManager",
				"name": "CONTAINER_MANAGER"
			}
		]
	},

```

Last we bind our DO classes to a binding name that we can reference inside the worker.

### Connecting with code

Inside our base `CommonContainerManager` class we accept as part of the constructor a map of binding names to bindings.
This allows us to lookup the correct binding to use by name at runtime.

```typescript
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
```


And in our `MyContainerManager` which extends this class we provide the bindingMap to the constructor mapping our 3 bindings to the names that reference them:

```typescript
export class MyContainerManager extends CommonContainerManager {
  constructor(ctx: DurableObjectState, env: Env) {
    const bindingMap: ContainerBindingMap = {
      small: env.CONTAINER_SMALL,
      medium: env.CONTAINER_MEDIUM,
      large: env.CONTAINER_LARGE,
    };
    super(ctx, env, bindingMap);
    this.ctx = ctx;
    this.env = env;
  }

```


This enables us to call target a specific compute size from our worker by doing:

```typescript
        await manager.newContainer(
          {
            env: startOpts.envVars,
            entrypoint: startOpts.entrypoint,
            enableInternet: startOpts.enableInternet,
          },
          startOpts.name,
          startOpts.size,
        );
```

Where startOpts.size is the users requested compute size.


