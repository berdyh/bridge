/**
 * A JSON-RPC 2.0 message as it travels inside the bridge channel. Structural only:
 * the ACP SDK (`AnyMessage`) is assignable to it, and this package does not depend
 * on the SDK.
 */
export type JsonRpcMessage = { jsonrpc: "2.0" } & Record<string, unknown>;

export function isJsonRpcMessage(v: unknown): v is JsonRpcMessage {
  return typeof v === "object" && v !== null && !Array.isArray(v) && (v as { jsonrpc?: unknown }).jsonrpc === "2.0";
}

/** ACP extension notification: the runner tells an enrolled browser a plugin's local UI URL. */
export const LOCAL_UI_METHOD = "_bridge/localUi";

/** Params of the `_bridge/localUi` notification. The URL is `http://127.0.0.1:<port>/...`. */
export type LocalUiParams = { pluginId: string; url: string };

/**
 * Splits an ACP extension method `_<pluginId>/<name>` into its parts. Returns
 * undefined for anything else, including the reserved `_bridge/` namespace, which
 * belongs to the runner itself.
 */
export function parseExtensionMethod(method: string): { pluginId: string; name: string } | undefined {
  const m = /^_([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)\/(.+)$/.exec(method);
  if (!m) return undefined;
  const pluginId = m[1] as string;
  if (pluginId === "bridge") return undefined;
  return { pluginId, name: m[2] as string };
}
