import { createBridgeApp, type BridgeServerConfig } from "@berdyh/bridge-server";

export type WorkerConfigFactory<Env> = (env: Env) => BridgeServerConfig;

/** Mount the core's Hono HttpHost; the Worker never owns relay sockets. */
export function createBridgeWorker<Env>(configFor: WorkerConfigFactory<Env>): ExportedHandler<Env> {
  const apps = new WeakMap<object, ReturnType<typeof createBridgeApp>>();
  return { fetch: (request, env) => {
    const key = env as object;
    let app = apps.get(key);
    if (!app) { app = createBridgeApp(configFor(env)); apps.set(key, app); }
    return app.fetch(request);
  } };
}
