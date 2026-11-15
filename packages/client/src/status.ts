import type { BridgeStatus } from "./contracts.js";
import type { PresenceBody } from "@berdyh/bridge-protocol";

/**
 * Derives the page's status for a runner from the relay's presence and the local trust signal
 * (`BridgeClient.isEnrolled`). `runners` is ordered most recently seen first. Several online
 * runners need a pick (`runner_selection_required`); with none online, the most recently seen
 * known runner is reported offline, so stale entries never force a picker.
 */
export async function deriveStatus(input: {
  runners: readonly PresenceBody[];
  runnerId?: string;
  isEnrolled(runnerId: string): Promise<boolean>;
}): Promise<BridgeStatus> {
  const { runners, runnerId, isEnrolled } = input;
  const online = runners.filter((runner) => runner.online);
  const candidates = online.length ? online : runners.slice(0, 1);
  if (runnerId === undefined && candidates.length > 1) return { state: "runner_selection_required" };
  const runner = runnerId === undefined ? candidates[0] : runners.find((runner) => runner.runnerId === runnerId);
  if (!runner) return { state: "no_runner" };
  if (!runner.online) return { state: "runner_offline", runner };
  return { state: await isEnrolled(runner.runnerId) ? "ready" : "online_not_enrolled", runner };
}
