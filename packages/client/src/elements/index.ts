import { wordsOf } from "@berdyh/bridge-protocol";
import type {
  BridgeClient, BridgeStatus, EnrollLink, PermissionPromptOptions, SetupInstructionsOptions,
} from "../contracts.js";
import { setupInstructions } from "../setup.js";

/** Collaborators are properties, allowing use with a facade as well as BridgeClient. */
export type SetupClient = Pick<BridgeClient, "status" | "onStatus" | "runners"> & {
  /** Re-renders the runner picker when runners come and go; optional for minimal facades. */
  onRunners?: BridgeClient["onRunners"];
  consumeEnrollLink(): EnrollLink | undefined;
  enroll?: BridgeClient["enroll"];
};

/** Register lazily: importing the client barrel in Node never needs a DOM. */
export function defineElements(): void {
  if (typeof HTMLElement === "undefined" || typeof customElements === "undefined") return;

  function node<K extends keyof HTMLElementTagNameMap>(tag: K, part: string, text?: string): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    element.setAttribute("part", part);
    if (text !== undefined) element.textContent = text;
    return element;
  }

  if (!customElements.get("bridge-permission")) {
    class BridgePermission extends HTMLElement {
      private root = this.attachShadow({ mode: "open" });
      private dismissals = new Set<() => void>();
      private prompts = new Map<HTMLElement, () => void>();

      /** Pass directly as permissionPrompt({ mount: element.mount }). Requests are shown one at a time. */
      mount: NonNullable<PermissionPromptOptions["mount"]> = (view, answer) => {
        if (!this.isConnected) { answer(null); return () => {}; }
        const panel = node("section", "prompt");
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-label", view.title ?? "Permission request");
        panel.tabIndex = -1;
        panel.append(node("h2", "title", view.title ?? "Permission request"));
        if (view.toolKind) panel.append(node("p", "tool-kind", view.toolKind));
        for (const location of view.locations ?? []) {
          panel.append(node("p", "location", location.path + (location.line == null ? "" : `:${location.line}`)));
        }
        if (view.rawInput !== undefined) {
          let raw: string;
          try { raw = JSON.stringify(view.rawInput, null, 2) ?? String(view.rawInput); }
          catch { raw = "[Input cannot be displayed]"; }
          panel.append(node("pre", "raw-input", raw));
        }
        let active = true;
        let allowAfter = Infinity;
        const finish = (id: string | null) => { if (active) { remove(); answer(id); } };
        const dismiss = () => finish(null);
        const remove = () => {
          if (!active) return;
          active = false;
          this.dismissals.delete(dismiss);
          const visible = panel.parentNode === this.root;
          this.prompts.delete(panel);
          panel.remove();
          if (visible && this.isConnected) this.prompts.values().next().value?.();
        };
        const actions = node("div", "actions");
        for (const option of view.options) {
          if (option.kind !== "allow_once" && option.kind !== "reject_once") continue;
          const button = node("button", option.kind === "allow_once" ? "allow" : "deny", option.name);
          button.type = "button";
          button.addEventListener("click", (event) => {
            if (panel.parentNode !== this.root || event.detail > 1) return;
            // A promoted prompt must not accept the click meant for its predecessor.
            if (option.kind === "allow_once" && performance.now() < allowAfter) return;
            finish(option.optionId);
          });
          actions.append(button);
        }
        const close = node("button", "dismiss", "Dismiss");
        close.type = "button";
        close.addEventListener("click", dismiss);
        actions.append(close);
        panel.append(actions);
        panel.addEventListener("keydown", (event) => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); }
        });
        this.dismissals.add(dismiss);
        this.prompts.set(panel, () => {
          allowAfter = performance.now() + 500;
          this.root.append(panel);
          panel.focus();
        });
        if (this.prompts.size === 1) this.prompts.get(panel)!();
        return remove;
      };

      disconnectedCallback(): void { for (const dismiss of [...this.dismissals]) dismiss(); }
    }
    customElements.define("bridge-permission", BridgePermission);
  }

  if (!customElements.get("bridge-setup")) {
    class BridgeSetup extends HTMLElement {
      private root = this.attachShadow({ mode: "open" });
      private currentClient?: SetupClient;
      private makeInstructions = setupInstructions;
      private unsubscribe?: () => void;
      private offStatus?: () => void;
      private revision = 0;
      private state?: BridgeStatus;
      private link?: EnrollLink;
      /** The runner the user picked from the picker; it outlives later "several online" emissions. */
      private selected?: string;
      private keyId?: string;
      private busy = false;
      private error?: string;
      private active = false;
      static observedAttributes = ["app-url", "app-name", "platform"];

      get client(): SetupClient | undefined { return this.currentClient; }
      set client(value: SetupClient | undefined) {
        this.stop();
        this.currentClient = value;
        this.state = undefined; this.link = undefined; this.selected = undefined; this.keyId = undefined; this.busy = false; this.error = undefined;
        if (this.isConnected) this.start();
      }
      get instructions(): typeof setupInstructions { return this.makeInstructions; }
      set instructions(value: typeof setupInstructions) { this.makeInstructions = value; if (this.isConnected) this.render(); }
      connectedCallback(): void {
        // Lazy registration must preserve collaborators assigned to an unknown tag.
        this.upgradeProperty("instructions");
        this.upgradeProperty("client");
        if (!this.active) this.start();
      }
      private upgradeProperty<K extends "client" | "instructions">(name: K): void {
        if (!Object.hasOwn(this, name)) return;
        const value = this[name];
        delete this[name];
        this[name] = value;
      }
      disconnectedCallback(): void { this.stop(); }
      attributeChangedCallback(): void { if (this.isConnected) this.render(); }
      private stop(): void {
        this.active = false; this.revision++; this.busy = false; this.keyId = undefined;
        this.unsubscribe?.(); this.unsubscribe = undefined;
        this.offStatus?.(); this.offStatus = undefined;
      }
      /** The runner status follows: the link's, else the user's pick. Default summaries never override it. */
      private get target(): string | undefined { return this.link?.runnerId ?? this.selected; }
      private subscribeStatus(client: SetupClient, revision: number, onFirst?: () => void): void {
        this.offStatus?.();
        const target = this.target;
        this.offStatus = client.onStatus((status) => {
          if (revision !== this.revision || target !== this.target) return;
          onFirst?.(); this.state = status; this.render();
        }, target);
      }
      private start(): void {
        this.stop(); this.active = true;
        const client = this.currentClient;
        if (!client) { this.render(); return; }
        const revision = this.revision;
        try {
          this.link ??= client.consumeEnrollLink();
          let notified = false;
          this.subscribeStatus(client, revision, () => { notified = true; });
          const off = client.onRunners?.(() => { if (revision === this.revision) this.render(); });
          this.unsubscribe = off;
          void client.status(this.target).then((status) => {
            if (revision !== this.revision || notified) return;
            this.state = status; this.render();
          }).catch(() => { if (revision === this.revision) { this.error = "Unable to read runner status."; this.render(); } });
        } catch { this.error = "Unable to read runner status."; }
        this.render();
      }
      /** Resolves status for one chosen runner; `status(runnerId)` is the client's selection API. */
      private async pick(runnerId: string): Promise<void> {
        const client = this.currentClient;
        if (!client || this.busy) return;
        const revision = this.revision;
        this.busy = true; this.error = undefined; this.render();
        try {
          const status = await client.status(runnerId);
          if (revision !== this.revision) return;
          this.selected = runnerId; this.state = status;
          this.subscribeStatus(client, revision);
        } catch { if (revision === this.revision) this.error = "Unable to read runner status."; }
        finally { if (revision === this.revision) { this.busy = false; this.render(); } }
      }
      private async pair(): Promise<void> {
        const client = this.currentClient;
        const link = this.link;
        if (!client?.enroll || !link || this.busy) return;
        const revision = this.revision;
        this.busy = true; this.error = undefined; this.render();
        try {
          await client.enroll(link.code, link.runnerId, { onBrowserKey: (id) => {
            if (revision !== this.revision) return;
            this.keyId = id; this.render();
          } });
          if (revision !== this.revision) return;
          const status = await client.status(link.runnerId);
          if (revision !== this.revision) return;
          this.selected = link.runnerId; this.link = undefined;
          this.state = status;
        } catch { if (revision === this.revision) this.error = "Pairing failed. Try again."; }
        finally { if (revision === this.revision) { this.busy = false; this.render(); } }
      }
      private render(): void {
        if (!this.active) return;
        this.root.replaceChildren();
        const panel = node("section", "panel");
        panel.setAttribute("aria-live", "polite");
        const state = this.state?.state;
        panel.setAttribute("data-state", state ?? "loading");
        const labels = {
          no_runner: "Set up your local runner", runner_offline: "Your runner is offline",
          online_not_enrolled: "Pair this browser", ready: "Ready", runner_selection_required: "Choose a runner",
        };
        panel.append(node("p", "status", state ? labels[state] : "Loading runner status…"));
        if (state === "runner_selection_required") {
          const picker = node("div", "runner-picker");
          picker.setAttribute("role", "group"); picker.setAttribute("aria-label", "Choose a runner");
          for (const runner of this.currentClient?.runners().filter((runner) => runner.online) ?? []) {
            const choice = node("button", "runner-option", runner.hostname || runner.runnerId);
            choice.type = "button"; choice.disabled = this.busy;
            // One deliberate click picks; a double click cannot also hit the panel that replaces this one.
            choice.addEventListener("click", (event) => { if (event.detail <= 1) void this.pick(runner.runnerId); });
            picker.append(choice);
          }
          panel.append(picker);
        } else if (state && state !== "ready") {
          const options: Omit<SetupInstructionsOptions, "flavor"> = {
            appUrl: this.getAttribute("app-url") ?? globalThis.location?.origin ?? "",
            appName: this.getAttribute("app-name") ?? "this app",
            platform: (this.getAttribute("platform") ?? (/Mac/i.test(globalThis.navigator?.platform ?? "") ? "darwin" : "linux")) === "darwin" ? "darwin" : "linux",
          };
          try {
            const human = this.makeInstructions({ ...options, flavor: "human" });
            if (state === "no_runner" || state === "runner_offline") {
              panel.append(node("pre", "one-liner", human.oneLiner));
              const copy = node("button", "copy", "Copy command");
              copy.type = "button";
              copy.addEventListener("click", () => {
                void (async () => {
                  try { await navigator.clipboard.writeText(human.oneLiner); copy.textContent = "Copied"; }
                  catch { copy.textContent = "Copy unavailable; select the command above"; }
                })();
              });
              panel.append(copy);
              if (state === "runner_offline" && options.platform === "linux") {
                const restart = node("a", "restart", "Start runner");
                restart.href = "bridge://run"; panel.append(restart);
              }
            }
            const agent = this.makeInstructions({ ...options, flavor: "agent" });
            const details = node("details", "agent");
            details.append(node("summary", "agent-summary", "Set up with a coding agent"), node("pre", "agent-prompt", agent.agentPrompt ?? ""));
            panel.append(details);
          } catch { panel.append(node("p", "error", "Setup instructions are unavailable.")); }
          if (this.link) {
            const runner = this.currentClient?.runners().find((runner) => runner.runnerId === this.link?.runnerId);
            const hostname = runner?.hostname ?? (this.state?.runner?.runnerId === this.link.runnerId ? this.state.runner.hostname : undefined);
            const pair = node("button", "pair", hostname ? `Pair with ${hostname}` : "Pair this browser");
            pair.type = "button"; pair.disabled = this.busy || !this.currentClient?.enroll;
            pair.addEventListener("click", () => { void this.pair(); }); panel.append(pair);
            if (this.keyId) panel.append(node("p", "words", wordsOf(this.keyId).join(" ")));
          }
        }
        if (this.error) panel.append(node("p", "error", this.error));
        this.root.append(panel);
      }
    }
    customElements.define("bridge-setup", BridgeSetup);
  }
}
