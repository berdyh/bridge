import { LOCAL_UI_METHOD, parseExtensionMethod } from "@berdyh/bridge-protocol";
import { PROXY_ERROR, type ExtensionRouter } from "../acp/contracts.js";
import type { PluginProcess } from "./contracts.js";

/** Routes `_<pluginId>/<name>` to running plugins, enforcing one app per plugin. */
export function createExtensionRouter(lookup: (pluginId: string) => { app: string; process: PluginProcess } | undefined): ExtensionRouter {
  const subscribers = new Set<{ caller: import("../acp/contracts.js").ExtensionCaller; push: (message: import("@berdyh/bridge-protocol").JsonRpcMessage) => void }>();
  const watched = new WeakSet<PluginProcess>();
  function deliver(pluginId: string, message: import("@berdyh/bridge-protocol").JsonRpcMessage) {
    const plugin = lookup(pluginId);
    if (!plugin || "id" in message || typeof message.method !== "string") return;
    if (parseExtensionMethod(message.method)?.pluginId !== pluginId && message.method !== LOCAL_UI_METHOD) return;
    for (const { caller, push } of subscribers) {
      if (caller.appId === plugin.app) { try { push(message); } catch { /* Closed browser. */ } }
    }
  }
  function target(method: string) {
    const parsed = parseExtensionMethod(method);
    const plugin = parsed ? lookup(parsed.pluginId) : undefined;
    if (plugin && !(lookup as PluginLookup).subscribe && !watched.has(plugin.process)) {
      watched.add(plugin.process);
      const process = plugin.process;
      process.onNotification((message) => {
        if (lookup(parsed!.pluginId)?.process === process) deliver(parsed!.pluginId, message);
      });
    }
    return plugin;
  }
  const request: ExtensionRouter["request"] = async (caller, method, params) => {
      const plugin = target(method);
      if (!plugin || caller.appId !== plugin.app) throw Object.assign(new Error("Unknown plugin"), { code: PROXY_ERROR.extensionNotFound });
      return plugin.process.call(method, params, caller);
  };
  return {
    // The caller-free contract can classify syntax, never inventory.
    handles: (method) => parseExtensionMethod(method) !== undefined,
    request,
    notify(caller, method, params) {
      // Notifications have no response, including on a missing/forbidden method.
      void request(caller, method, params).catch(() => {});
    },
    subscribe(caller, push) {
      // lookup is intentionally lazy: a subscription made before start must also
      // see a plugin installed later. The host supplies the optional registry hook.
      const observable = lookup as PluginLookup;
      if (!observable.subscribe) {
        const subscription = { caller: { ...caller }, push };
        subscribers.add(subscription);
        return () => { subscribers.delete(subscription); };
      }
      return observable.subscribe((pluginId, message) => {
        const plugin = lookup(pluginId);
        if (!plugin || plugin.app !== caller.appId || "id" in message) return;
        const method = message.method;
        if (typeof method !== "string") return;
        if (parseExtensionMethod(method)?.pluginId !== pluginId && method !== LOCAL_UI_METHOD) return;
        try { push(message); } catch { /* A closed browser cannot crash the plugin. */ }
      });
    },
  };
}

/** Host registry hook, including notifications from plugins added after subscribe. */
export type PluginLookup = ((pluginId: string) => { app: string; process: PluginProcess } | undefined) & {
  subscribe?: (push: (pluginId: string, message: import("@berdyh/bridge-protocol").JsonRpcMessage) => void) => () => void;
};
