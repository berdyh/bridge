import type { PermissionHandler, PermissionPromptOptions, PermissionView } from "./contracts.js";

type PermissionRequest = Parameters<PermissionHandler>[0] & { signal?: AbortSignal };

/** ACP request handler. Every path except a valid UI choice denies permission. */
export function permissionPrompt(options: PermissionPromptOptions = {}): (args: PermissionRequest) => ReturnType<PermissionHandler> {
  return ({ params, signal }) => new Promise((resolve) => {
    // Copy the forwarded choices so a renderer cannot change the authorization set.
    const choices = params.options.filter(({ kind }) => kind === "allow_once" || kind === "reject_once")
      .map(({ optionId, name, kind }) => ({ optionId, name, kind }));
    const rejectId = choices.find(({ kind }) => kind === "reject_once")?.optionId;
    let settled = false;
    let unmount: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      const remove = unmount;
      unmount = undefined;
      try { remove?.(); } catch { /* Cleanup must never prevent the denial response. */ }
    };
    const answer = (id: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", deny);
      const optionId = !signal?.aborted && choices.some((choice) => choice.optionId === id) ? id : rejectId;
      resolve({ outcome: optionId == null ? { outcome: "cancelled" } : { outcome: "selected", optionId } });
      cleanup();
    };
    const deny = () => answer(null);
    if (!options.mount || signal?.aborted) { deny(); return; }
    signal?.addEventListener("abort", deny, { once: true });
    if (options.timeoutMs !== undefined) timer = setTimeout(deny, Math.max(0, options.timeoutMs));
    const tool = params.toolCall;
    const view: PermissionView = {
      sessionId: params.sessionId,
      ...(tool.title != null && { title: tool.title }),
      ...(tool.kind != null && { toolKind: tool.kind }),
      ...(tool.locations != null && { locations: tool.locations.map(({ path, line }) => ({ path, ...(line != null && { line }) })) }),
      ...(tool.rawInput !== undefined && { rawInput: tool.rawInput }),
      options: choices.map((choice) => ({ ...choice })),
    };
    try {
      unmount = options.mount(view, answer);
      // A mount can answer synchronously, before returning its cleanup function.
      if (settled) cleanup();
    } catch { deny(); }
  });
}
