# Vitrus Python SDK

A Python client for multi Agent-World-Actor orchestration, with easy-to-use spatial perception _Workflows_.
For detailed documentation and more examples access [Vitrus Docs](https://vitrus.gitbook.io/docs/concepts).

## Installation
Install from source
```bash
pip install git+https://github.com/vitrus-ai/vitrus-sdk-python.git
```

## Communication

The SDK now supports two runtime paths:

1. Vitrus Device Runtime through Vitrus Bridge. This is the preferred path for devices, actors, live status, and browser/cloud control.
2. Legacy DAO actor communication. This remains available for existing actor workflows.

The deployed Bridge service is the Render `vitrus-dataplane` service at `https://vitrus-dataplane.onrender.com`. This is the SDK default. Override it with `bridge_url=` or `VITRUS_BRIDGE_URL` for local development or another deployment.

## Droid Control

The device-first Droid API uses only `DROID_NAME` and `VITRUS_API_KEY` by default. Leases are authorized by the Bridge and joint targets use the native Zenoh transport on the edge.

```python
import asyncio
from vitrus import Droid


async def main():
    droid = await Droid.from_env()
    lease = await droid.acquire(owner="python-control")
    try:
        await droid.send_targets(
            [{"joint_name": "NECK_HEAD", "position_deg": 5}],
            lease["id"],
        )
    finally:
        await droid.release(lease["id"])
        await droid.close()


asyncio.run(main())
```

The native Python Zenoh endpoint defaults to `tcp/127.0.0.1:7447` on VitrusOS. It can be overridden for another edge without changing the application contract.

```python
from vitrus import Vitrus

vitrus = Vitrus(
    api_key="...",
    world="factory-floor",
    bridge_url="http://127.0.0.1:8788",
)
```

## Device Runtime

Create a Vitrus device and expose actors/capabilities from the same Python process:

```python
import asyncio
import os
from vitrus import Vitrus


async def main():
    vitrus = Vitrus(
        api_key=os.environ["VITRUS_BRIDGE_API_KEY"],
        world=os.environ["VITRUS_WORLD_ID"],
        bridge_url=os.environ.get("VITRUS_BRIDGE_URL", "http://127.0.0.1:8788"),
    )

    device = await vitrus.device(
        key="local-compute-device",
        name="Local Compute Device",
        kind="computer",
    )

    actor = device.actor(
        "utility.echo.v1",
        capabilities=["utility.echo"],
    )

    @actor.command("echo")
    async def echo(message: str):
        return {"message": message}

    await device.run_forever()


asyncio.run(main())
```

Client-side Python can discover devices and call actors through the Bridge:

```python
devices = await vitrus.list_devices(online=True)
actor = await vitrus.actor("utility.echo.v1", device="local-compute-device")
result = await actor.run("echo", message="hello")
```

Emergency stop has a dedicated helper:

```python
await vitrus.emergency_stop("dev_123", reason="operator_requested")
```

Environment variables for local Bridge development:

```bash
VITRUS_BRIDGE_URL=http://127.0.0.1:8788
VITRUS_BRIDGE_API_KEY=dev-bridge-key
VITRUS_WORLD_ID=local-lab
```

## Legacy DAO Communication

Agent–actor traffic (commands, responses, broadcasts, events) uses **Zenoh** as the core transport. The client connects to the DAO over WebSocket once for handshake (API key, world ID) and receives `routerUrl`; all further communication uses Zenoh. The DAO must be started with `ZENOH_ROUTER_URL` set so the handshake returns the router URL.

## Authentication

[How to get an API Key](https://vitrus.com)

```python
import asyncio
import os
from vitrus import Vitrus

async def main():
    # Initialize the client with all options
    vitrus = Vitrus(
        api_key=os.environ.get("VITRUS_API_KEY", "YOUR_API_KEY"),
        # Optional parameters
        world=os.environ.get("VITRUS_WORLD_ID", "your_world_id"),  # Required for actors
        base_url="wss://vitrus-dao.onrender.com",  # Default value
        debug=False  # Set to True for debugging
    )
    
    # Authentication happens automatically when needed
    
asyncio.run(main())
```

# Workflows

**Workflows** have a similar schema as AI tools, so it connects perfectly with [OpenAI function Calling](https://platform.openai.com/docs/guides/function-calling?api-mode=chat). Making Workflows great to compose complex physical tasks with AI Agents. The following is a simple example of how to run a workflow:

```python
import asyncio
import os
from vitrus import Vitrus

async def main():
    vitrus = Vitrus(api_key=os.environ.get("VITRUS_API_KEY"))
    
    # List available workflows
    workflows = await vitrus.list_workflows()
    print("Available workflows:")
    for workflow in workflows:
        print(f"- {workflow['function']['name']}")
    
    # Run a basic workflow
    result = await vitrus.workflow("hello-world", {
        "prompt": "hello world!"
    })
    
    print(f"Result: {result}")
    
asyncio.run(main())
```

Workflows are executed in Cloud GPUs (e.g. `Nvidia A100`), and combine multiple AI models for complex tasks.

## Available Workflows

We are continously updating the available workflows, and keeping them up to date with state-of-the-art (SOTA) AI models. Use `list_workflows()` to see all available workflows and their schemas.

# Worlds and Actors

Create a world at [app.vitrus.ai](https://app.vitrus.ai).

## Actors

Actors are entities that can receive and respond to commands within a world.

```python
import asyncio
import os
from vitrus import Vitrus

async def main():
    vitrus = Vitrus(
        api_key=os.environ.get("VITRUS_API_KEY"),
        world=os.environ.get("VITRUS_WORLD_ID")  # Required for actors
    )

    # Create an actor with metadata
    actor = await vitrus.actor("forest", {
        "human": "Tom Hanks",
        "eyes": "green"
    })

    # Register a command handler
    def walk(direction, speed=None):
        print(f"Received walk command: direction={direction}, speed={speed}")
        return f"run forest, run! Going {direction}" + (f" at {speed} speed" if speed else "")
    
    # Register the handler
    actor.on("walk", walk)
    
    print(f"Actor '{actor.name}' is listening for commands...")
    print("Press Ctrl+C to exit")
    
    # Keep the connection open
    try:
        while True:
            await asyncio.sleep(1)
    except KeyboardInterrupt:
        print("\nShutting down actor...")
        actor.disconnect()
    
asyncio.run(main())
```

## Agents

On the Agent side, once connected to a world, the actor can be treated as "functions".

```python
import asyncio
import os
from vitrus import Vitrus

async def main():
    vitrus = Vitrus(
        api_key=os.environ.get("VITRUS_API_KEY"),
        world=os.environ.get("VITRUS_WORLD_ID")  # Must match actor's world
    )

    # Get a handle to an actor without providing metadata
    # (This doesn't create the actor, just gives a handle to interact with it)
    actor = await vitrus.actor("forest")

    # Run a command on the actor with positional arguments
    response = await actor.run("walk", "north", "fast")
    print(f"Response: {response}")
    
asyncio.run(main())
```

## Scene Management

For spatial applications, you can manage scenes:

```python
import asyncio
from vitrus import Vitrus

async def main():
    vitrus = Vitrus(api_key="YOUR_API_KEY", world="YOUR_WORLD_ID")
    
    # Get a scene
    scene = vitrus.scene("my-3d-environment")
    
    # Add an object to the scene
    scene.add({
        "id": "cube1",
        "type": "cube",
        "position": [0, 1, 0],
        "scale": [1, 1, 1]
    })
    
    # Update an object
    scene.update({
        "id": "cube1",
        "position": [0, 2, 0]
    })
    
    # Get the full scene
    scene_data = scene.get()
    print(scene_data)
    
asyncio.run(main())
```

## Error Handling

The SDK uses Python's exceptions for error handling:

```python
import asyncio
from vitrus import Vitrus

async def main():
    try:
        vitrus = Vitrus(api_key="INVALID_API_KEY")
        await vitrus.list_workflows()
    except Exception as e:
        print(f"Error: {e}")
    
asyncio.run(main())
```

## Troubleshooting

**Connection Issues**
- Ensure your API key is valid
- Check that the world ID exists (if using actors)
- Verify your internet connection and any firewall settings
- Set `debug=True` to see detailed logs of the connection process

**Actor/Command Issues**
- Actor commands are case-sensitive
- Ensure the actor is registered in the world before running commands
- Parameter types should match what's expected by the handler

---

# How Vitrus works internally

Vitrus workflows, worlds, actors and agents run on top of Distributed Actor Orchestration (DAO). A lightweight cloud system that enables the cross-communication of agents-world-actors. 
