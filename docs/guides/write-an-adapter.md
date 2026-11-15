# Write an adapter

There are two kinds of adapter. An **agent backend** runs on the user's machine and is
what the runner drives. A **server adapter** supplies a runtime, a store or auth for an
app's bridge server.

## Agent backend

The runner talks ACP over stdio to every agent. An adapter implements `AgentAdapter` from
`@berdyh/bridge-runner`:

```ts
interface AgentAdapter {
  readonly id: string; // protocol agent id, e.g. "claude"
  availability(): Promise<AgentAvailability>;
  spawn(options: { cwd: string; signal?: AbortSignal }): Promise<AgentProcess>;
}
interface AgentProcess {
  readonly stream: MessageStream<JsonRpcMessage>; // the agent's ACP connection
  readonly pid?: number;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  kill(): Promise<void>;
}
```

The adapter owns discovery, credential staging and the environment sandbox, so the proxy
never sees a secret. For any agent that speaks ACP over stdio, use the helper instead of
writing this yourself:

```ts
import { createAcpAgentAdapter } from "@berdyh/bridge-runner";

const opencode = createAcpAgentAdapter({
  id: "opencode",
  command: ["opencode-acp"], // example name; absolute path, or names looked up on PATH, first hit wins
  args: [],
  environment: { env: process.env, homedir: os.homedir(), tmpBase: os.tmpdir() },
});
```

Each `spawn` gets a throwaway directory with a stripped env and its own HOME and TMPDIR,
runs the agent in the session's `cwd`, and removes the directory when the agent exits.
`credentialsFor` stages a login (`"claude-code"` or `"codex-cli"`) into that sandbox; leave
it out for an agent that needs none. The file staged is the `authFiles` entry for that agent.
The `bridge` CLI sets both entries to bridge's own logins under
`~/.config/bridge/agents/<agent>/` (see `bridge agent login`), so the runner never reads
`~/.claude` or `~/.codex`. An agent with no `authFiles` entry stages nothing.

`createDefaultAgentAdapters()` builds the two built-in adapters: `claude` (by default
`claude-agent-acp`, then `claude-code-acp`) and `codex` (`codex-acp`). Called bare, it looks
them up on `PATH`. The `bridge` CLI passes its own lookup: for claude, `$BRIDGE_CLAUDE_ADAPTER`
when set, then bridge's own copy of `claude-agent-acp` (installed by `bridge agent install
claude`, or the package's dev dependency in a source checkout), then `claude-agent-acp` and
`claude-code-acp` on `PATH`; a copy on `PATH` cannot shadow bridge's own. For codex it passes
`$BRIDGE_CODEX_ADAPTER` when set, then bridge's own copy of `codex-acp` (installed by `bridge agent
install codex`, a pinned `@agentclientprotocol/codex-acp`), then `codex-acp` on `PATH`; see
[Operate the runner](operate-the-runner.md).

**Using your adapter.** The `bridge` binary uses the built-in adapters only. To run others,
embed the CLI: `runCli(argv, { ...createDefaultDeps(), adapters: [...] })` from `@berdyh/bridge`
takes an `adapters` list, and `startRunner` accepts the same deps. Which agents a session may
use is further limited by the local policy file (`agents`).

## Server adapters

The server core, `@berdyh/bridge-server`, depends only on the interfaces in its
`src/contracts.ts`. An adapter supplies up to four of them:

| Interface | You implement it to bring | Shipped |
|---|---|---|
| `DeviceStore` | Storage for runner devices | Neon, D1, in-memory (Node package) |
| `AuthVerifier` | App-user and runner token checks | Clerk, a stub (Node package) |
| `RelayGateway` | The HTTP side of the relay | Durable Object forwarder, `ws` |
| `RelayTransport` | The sockets (extends `RelayGateway`) | Durable Object, `ws` |

The contract details live in [packages/server/README.md](../../packages/server/README.md).
The points that matter most:

- **Store.** Every method is scoped by `userId`. `touchLastSeen` must be one atomic
  conditional write: the core only de-duplicates calls per connection, so across
  connections the store is the throttle. `revokeDevice` must also revoke every credential id bound to the device.
  Revoked tombstones must be kept.
- **Auth.** Return `undefined` for a bad token and reject only for infrastructure failures
  (the core answers 503). Give runner principals a stable `credentialId`, and implement
  `revokeRunnerCredentials` if your identity provider supports it. If you cannot give a
  stable id, revocation is limited to the device id, and your docs must say so.
- **Transport.** Call the handler's `onOpen`, `onMessage` (text frames only; close binary
  frames with 1003) and `onClose`, one connection at a time. Replace an older browser socket
  of the same `(userId, browserKeyId)` with close code 4409 before `onOpen`. `send` never
  throws and must enforce a queue limit (`dropped_backpressure`). The core keeps no timers, so
  the transport must ping idle sockets, close a runner that has not greeted within a short
  time (1008), refresh `lastSeen` through `DeviceStore.touchLastSeen`, and answer the text
  heartbeat `bridge:ping` with `bridge:pong` (the core never sees either string).
- **Wiring.** In the relay context, build the core and bind it:
  `transport.bind(createRelayCore(config, transport))`. In the stateless HTTP context, pass a
  `RelayGateway` to `createBridgeApp`.
- **Reconnect.** No adapter may buffer messages for absent peers. Endpoints replay by `seq`
  after a reconnect, whichever adapter is used.

Start from the shipped adapters as references: `packages/server-node` (the simplest relay)
and `packages/server-cf` (hibernation and alarms).
