# @berdyh/bridge-server-node

The reference server adapter for Node: a `ws` relay transport, an in-memory device store and a stub auth verifier, wired together by `createNodeBridgeServer`. The defaults are for local development and tests; bring your own store and verifier for anything real. See [Add the bridge to an app](../../docs/guides/add-to-an-app.md) and [Write an adapter](../../docs/guides/write-an-adapter.md).

```ts
import { createNodeBridgeServer } from "@berdyh/bridge-server-node";

const server = await createNodeBridgeServer({
  app: { id: "my-app", name: "My app" },
  auth: {
    issuer: "https://idp.example",
    clientId: "my-runner-client",
    deviceAuthorizationEndpoint: "https://idp.example/oauth/device_authorization",
    tokenEndpoint: "https://idp.example/oauth/token",
  },
  enrollPage: "/bridge/enroll",
});
console.log(server.url);
// await server.close();
```

`enrollPage` is optional and appears in `/.well-known/bridge.json` when set. The
app serves that page. The core validates discovery at construction: use a path
starting with a single `/` on the app origin, with no query, fragment, backslash,
space or control character. Absolute and off-origin URLs are rejected; a rejected
configuration closes the Node listener and transport.

Online presence includes the runner's `hostname` when it passes the protocol's
`boundedHostname` (1–255 characters, no controls or line/paragraph separators),
including for browsers that connect later. Invalid names are omitted from presence
and stored as `"unknown"` in device records; offline presence omits the name.
Render it as display text, never as HTML or an identifier.
