import { describe, expectTypeOf, it } from "vitest";

import type {
  BridgeServerConfig,
  DeviceStore,
  HttpHost,
  Principal,
  RelayGateway,
  RelayHandler,
  RelayTransport,
  RevokeResult,
  UpgradeAuthorization,
  UpgradeVerdict,
  UpsertResult,
} from "./index.js";
import { createBridgeApp, createDeviceService, createRelayCore } from "./index.js";

describe("relay split (Workers: the Worker holds a gateway, the Durable Object a transport)", () => {
  it("lets createBridgeApp run with a gateway that has no socket members", () => {
    // A Worker-side forwarder only implements accept and disconnect.
    expectTypeOf<BridgeServerConfig["adapters"]["relay"]>().toEqualTypeOf<RelayGateway>();
    expectTypeOf<RelayGateway>().not.toHaveProperty("bind");
    expectTypeOf<RelayGateway>().not.toHaveProperty("send");
    expectTypeOf<RelayTransport>().toExtend<RelayGateway>();
    expectTypeOf(createBridgeApp).parameters.toEqualTypeOf<[BridgeServerConfig]>();
    expectTypeOf(createBridgeApp).returns.toEqualTypeOf<HttpHost>();
  });

  it("builds the core from the relay context's transport, not from the config", () => {
    expectTypeOf(createRelayCore).parameters.toEqualTypeOf<[BridgeServerConfig, RelayTransport]>();
    expectTypeOf(createRelayCore).returns.toEqualTypeOf<RelayHandler>();
  });
});

describe("device store: last seen and credentials", () => {
  it("throttles inside the store with one atomic call", () => {
    expectTypeOf<DeviceStore["touchLastSeen"]>().parameters.toEqualTypeOf<[string, string, string, number]>();
    expectTypeOf<DeviceStore["touchLastSeen"]>().returns.toEqualTypeOf<Promise<boolean>>();
    expectTypeOf(createDeviceService).returns.toHaveProperty("recordSeen");
  });

  it("keeps a durable device-to-credential association that revocation can act on", () => {
    expectTypeOf<Principal>().toHaveProperty("credentialId");
    expectTypeOf<DeviceStore["upsertDevice"]>().parameters.toEqualTypeOf<[Parameters<DeviceStore["upsertDevice"]>[0], (string | undefined)?, (string | undefined)?]>();
    expectTypeOf<UpsertResult>().toEqualTypeOf<"ok" | "revoked" | "credential_revoked">();
    expectTypeOf<DeviceStore["revokeDevice"]>().returns.toEqualTypeOf<Promise<RevokeResult | undefined>>();
    expectTypeOf<RevokeResult["credentialIds"]>().toEqualTypeOf<string[]>();
    expectTypeOf<DeviceStore["isCredentialRevoked"]>().returns.toEqualTypeOf<Promise<boolean>>();
  });
});

describe("upgrade authorization verdict (additive)", () => {
  it("keeps ok: true as the only registering outcome and adds an optional verdict to failures", () => {
    expectTypeOf<Extract<UpgradeAuthorization, { ok: true }>>().toEqualTypeOf<{ ok: true; peer: Parameters<RelayGateway["accept"]>[1] }>();
    expectTypeOf<Extract<UpgradeAuthorization, { ok: false }>["response"]>().toEqualTypeOf<Response>();
    expectTypeOf<Extract<UpgradeAuthorization, { ok: false }>["verdict"]>().toEqualTypeOf<UpgradeVerdict | undefined>();
    expectTypeOf<UpgradeVerdict>().toEqualTypeOf<{ type: "revoked"; runnerId: string }>();
  });

  it("lets a gateway leave the verdict out", () => {
    expectTypeOf<RelayGateway["acceptVerdict"]>().toEqualTypeOf<((request: Request, verdict: UpgradeVerdict) => Promise<Response>) | undefined>();
  });
});

describe("credential fingerprint lookup (additive)", () => {
  it("is optional on the store and answers only the credential, never a device", () => {
    expectTypeOf<DeviceStore["revokedCredentialByFingerprint"]>().toEqualTypeOf<((fingerprint: string) => Promise<{ userId: string; credentialId: string } | undefined>) | undefined>();
  });
});
