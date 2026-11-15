import {
  selectProtocolVersion,
  type ControlBody,
  type ProtocolRange,
  type RunnerHello,
  type ServerWelcome,
} from "@berdyh/bridge-protocol";

export type HandshakeOutcome =
  | { ok: true; welcome: ServerWelcome }
  /** Send `reply` as a control envelope to the runner, then close the socket. */
  | { ok: false; reply: ControlBody };

/** Negotiates the protocol version for a runner `hello`. See `RunnerHello`. */
export function negotiateHandshake(hello: RunnerHello, server: ProtocolRange, latestRunnerVersion?: string): HandshakeOutcome {
  const protocol = selectProtocolVersion(hello.protocol, server);
  if (protocol !== undefined) return { ok: true, welcome: { type: "welcome", protocol } };
  if (hello.protocol.max < server.min) {
    return {
      ok: false,
      reply: {
        type: "update_required",
        server: { min: server.min, max: server.max },
        ...(latestRunnerVersion ? { latestRunnerVersion } : {}),
        message: "This runner is too old for this server. Update the bridge runner.",
      },
    };
  }
  return {
    ok: false,
    reply: { type: "error", code: "protocol_mismatch", message: "This server is older than the runner supports." },
  };
}
