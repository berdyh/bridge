import { connectBridge, type BridgeClient, type BridgeStatus, type EnrolledRunner, type KeyStore } from "@berdyh/bridge-client";
import { wordsOf } from "@berdyh/bridge-protocol";
import WsWebSocket from "ws";
import { vi } from "vitest";

import type { Machine } from "./machine.js";
import { memoryKeyStore, type AppDeployment } from "./world.js";

/**
 * A headless stand-in for an app's page. It does what the
 * kit's client does in a browser and nothing a browser cannot:
 *  - it signs in (the app's session token) and watches `status()` / `onStatus()`;
 *  - it arrives on the enroll page by LINK. The code is never given to it: `pair(link)` runs the
 *    client's own `consumeEnrollLink()` against a fake `location` whose fragment holds the code, which
 *    scrubs the fragment, and enrolls with what that returned;
 *  - it reports the four words its key shows (`onBrowserKey` -> `wordsOf`), which the person compares
 *    with the terminal's.
 */
export class HeadlessPage {
  /** The states `status()` went through, consecutive repeats dropped (starts with the first answer). */
  readonly states: string[] = [];
  /** What the fragment of the page's URL was after `consumeEnrollLink()` ran (it must be empty). */
  fragmentAfterConsume: string | undefined;

  private constructor(
    readonly bridge: BridgeClient,
    readonly keyStore: KeyStore,
  ) {}

  /** Opens the page: connects, then records the first status and every change. */
  static async open(app: AppDeployment, options: { keyStore?: KeyStore; token?: string; label?: string; e2ee?: boolean } = {}): Promise<HeadlessPage> {
    const keyStore = options.keyStore ?? memoryKeyStore();
    const bridge = await connectBridge({
      discoveryUrl: `${app.server.url}/.well-known/bridge.json`,
      getSessionToken: async () => options.token ?? app.browserToken,
      keyStore,
      e2ee: options.e2ee ?? true,
      label: options.label ?? "e2e headless page",
      webSocket: originWebSocket(app.server.url),
    });
    const page = new HeadlessPage(bridge, keyStore);
    // Subscribe before the first read: a change between the two must not be lost.
    bridge.onStatus((status) => page.note(status));
    page.note(await bridge.status());
    return page;
  }

  private note(status: BridgeStatus): void {
    if (this.states[this.states.length - 1] !== status.state) this.states.push(status.state);
  }

  /** Waits until `status()` answers `state` (and returns that status); the states seen are in `states`. */
  async waitForState(state: BridgeStatus["state"], timeoutMs = 20_000, runnerId?: string): Promise<BridgeStatus> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = await this.bridge.status(runnerId);
      this.note(status);
      if (status.state === state) return status;
      if (Date.now() > deadline) throw new Error(`status stayed ${status.state}, not ${state} (seen: ${this.states.join(" > ")})`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /**
   * Arrives on the enroll page at `link` and starts pairing. Resolves at once with `words`, a promise for the four
   * words this browser's key shows (known before the runner is asked), and `enrolled`, which settles when the
   * person on the terminal has answered. The caller never sees or types the code.
   */
  async pair(link: string): Promise<{ words: Promise<string[]>; enrolled: Promise<EnrolledRunner> }> {
    const { consumeEnrollLink } = await freshClient();
    const url = new URL(link);
    const document = fakeDocument(url);
    let found;
    try {
      found = consumeEnrollLink();
      this.fragmentAfterConsume = document.location.hash;
    } finally {
      document.restore();
    }
    if (!found) throw new Error(`the page found no enroll link in ${url.origin}${url.pathname}#...`);
    let seen!: (words: string[]) => void;
    const words = new Promise<string[]>((resolve) => (seen = resolve));
    const enrolled = this.bridge.enroll(found.code, found.runnerId, { onBrowserKey: (keyId) => seen(wordsOf(keyId)) });
    // A failed enrollment must not stay an unhandled rejection while the test is busy elsewhere.
    enrolled.catch(() => undefined);
    return { words, enrolled };
  }

  close(): void {
    this.bridge.close();
  }
}

/** A copy of the client module with its own once-per-document state, as each page load has. */
async function freshClient(): Promise<typeof import("@berdyh/bridge-client")> {
  vi.resetModules();
  return import("@berdyh/bridge-client");
}

/** The `ws` client with the `Origin` header a browser would send; the server rejects browser sockets without it. */
function originWebSocket(origin: string): typeof globalThis.WebSocket {
  return class extends WsWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols, { headers: { origin } });
    }
  } as unknown as typeof globalThis.WebSocket;
}

/** Installs a `location`, `history` and `sessionStorage` for one page load, and restores the globals after. */
function fakeDocument(url: URL): { location: { hash: string }; restore(): void } {
  const location = { hash: url.hash, pathname: url.pathname, search: url.search, href: url.href };
  const history = {
    state: null as unknown,
    replaceState(_state: unknown, _title: string, target: string) {
      const next = new URL(target, url);
      location.pathname = next.pathname;
      location.search = next.search;
      location.hash = next.hash;
    },
  };
  const store = new Map<string, string>();
  const sessionStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  const names = { location, history, sessionStorage };
  const saved = Object.entries(names).map(([name]) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(names)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  return {
    location,
    restore() {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete (globalThis as Record<string, unknown>)[name];
      }
    },
  };
}

/**
 * Pairs `page` with the runner of `machine` the way an agent would: `bridge enroll <app> --json` shows the enroll
 * link, the page consumes it, and a second process answers the trust request with the words the page reports.
 * Needs a running runner for the app and an app that advertises an enroll page.
 */
export async function enrollBrowser(machine: Machine, page: HeadlessPage, appId: string): Promise<EnrolledRunner> {
  const enrolling = machine.start(["enroll", appId, "--json"]);
  try {
    const shown = JSON.parse((await enrolling.waitFor(/^(\{"event":"code".*\})$/m))[1]!) as { enrollUrl?: string };
    if (!shown.enrollUrl) throw new Error("the app advertises no enroll page");
    const pairing = await page.pair(shown.enrollUrl);
    const words = await pairing.words;
    await enrolling.waitFor(/"event":"trust_request"/);
    const approved = await machine.exec(["enroll", "approve", appId, "--words", words.join(" ")]);
    if (approved.code !== 0) throw new Error(`enroll approve failed: ${approved.stderr}${approved.stdout}`);
    return await pairing.enrolled;
  } finally {
    await enrolling.stop();
  }
}
