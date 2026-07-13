# Vitrus

## Droids

`Vitrus.Droid` is the device-first API for connecting an application to a
registered Vitrus robot. Use a serial number and an organization API key.

```ts
import Vitrus from "vitrus";

const droid = await Vitrus.Droid.connect("VTRS-R05-2607-ABCDZ", {
  apiKey: process.env.VITRUS_API_KEY!,
});

const identity = await droid.identity.get();
const description = await droid.description.get();
const telemetry = await droid.telemetry.snapshot();
const frame = await droid.camera.getFrame("head_camera");
```

Control requires an API key with the appropriate scope and a short-lived lease:

```ts
const lease = await droid.control.acquire({ durationMs: 5_000 });

await droid.motion.sendTargets(
  [{ jointName: "ARM_JOINT", displayDeg: 5 }],
  { leaseId: lease.id },
);
```

The service validates every command before it reaches the robot. No hardware
protocols, internal networking details, or device implementation are exposed by
the SDK.

[![latest version](https://badgen.net/npm/v/vitrus?label=latest)](https://www.npmjs.com/package/vitrus)
[![install size](https://badgen.net/packagephobia/install/vitrus?label=npm+install)](https://packagephobia.now.sh/result?p=vitrus)
[![NPM downloads weekly](https://badgen.net/npm/dw/vitrus?label=npm+downloads&color=purple)](https://www.npmjs.com/package/vitrus)

![LinkedIn cover - 1 (4)](https://github.com/user-attachments/assets/0edc608b-82af-41f1-9fd5-e693875ca6a9)
A TypeScript client for multi Agent-World-Actor orchestration, with easy-to-use spatial perception _Workflows_.
For detailed documentation and more examples access [Vitrus Docs](https://vitrus.gitbook.io/docs/concepts).

💡 Tip: If anything takes more than 2 minutes to setup, ask in our [Discord channel](https://discord.gg/Xd5f6WSh).


## Installation

```bash
# Using npm
npm install vitrus

# Using bun
bun add vitrus
```

## Communication

Agent–actor traffic (commands, responses, broadcasts, events) uses **Websockets** as the core transport. The client connects to AI agents over WebSocket once for handshake (API key, world ID).

## Authentication

[Get an API Key](https://app.vitrus.ai)

```typescript
import Vitrus from "vitrus";

// Initialize the client with all options
const vitrus = new Vitrus({
  apiKey: process.env["VITRUS_API_KEY"],
});
```

<br/>

# Workflows

```typescript
// running a basic workflow
const result = await vitrus.workflow("hello-world", {
  prompt: "hello world!",
});

console.log(result);
```

Workflows are processed in server-side GPUs (e.g. `Nvidia A100`), and are custom per server.

## Available Workflows

We are continously updating the available workflows, and keeping them up to date with state-of-the-art (SOTA) AI models. For the latest list of workflows, you can execute:

```ts
const workflows = vitrus.list_workflows();
console.log(workflows);
```

<br/>

# Worlds and Actors

Create a world at [app.vitrus.ai](https://app.vitrus.ai).

```typescript
import Vitrus from "vitrus";

// Initialize the client
const vitrus = new Vitrus({
  apiKey: "your-api-key",
 // baseUrl: "ws://<dao-server>:<port>" defines an alternate server
});
```

## Actors actions

```ts
import Vitrus from "vitrus";

const vitrus = new Vitrus({
  apiKey: "<your-api-key>",
  world: "<selected-world-id>",
});

const actor = await vitrus.actor("forest", {
  droid: "r2d2",
  weapon: "that little electric thing!",
  purpose: `find Luke to give him the princess' hologram message about the death star`
});

actor.on("walk", (args: any) => {
  console.log("received", args);
  return "I roll";
});

actor.broadcast("status" , { alive: true });
```

## Agents

On the Agent side, once connected to, the actor can be treated as "functions".

```ts
import Vitrus from "vitrus";

const vitrus = new Vitrus({
  apiKey: "<your-api-key>",
  world: "<world-id>", //must match actor's world
});

const actor = await vitrus.actor("forest");

const resp = await actor.run("walk", {
  direction: "front",
});
```

## Actor → Agent events

Ad-hoc events let an **actor** notify **agents** about local state changes.

```ts
// actor side
actor.event("voice_activity", { data: true });

// agent side
actor.listen("voice_activity", (args) => {
  console.log("voice activity:", args);
});
```

---

# How Vitrus works internally

Vitrus workflows, worlds, actors and agents runs on top of Distributed Actor Orchestration (DAO). A lightweight cloud system that enables the cross-communication of agents-world-actors.
