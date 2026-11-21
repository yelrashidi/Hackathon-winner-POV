// TEMP: db — one in-memory state for the whole server process. It resets when the server
// restarts. Kept on globalThis so Next's dev reloads don't wipe it between requests.

import type { PaymentsState } from "../types";
import { ensureApprovalsSeeded, reseedApprovals } from "./approval-seed";
import { loadDatasetState } from "./load";

const KEY = Symbol.for("harborline.payments.state");
type Holder = { [KEY]?: PaymentsState };

export function getState(): PaymentsState {
  const g = globalThis as Holder;
  g[KEY] ??= loadDatasetState();
  return g[KEY];
}

/** TEMP: approvals — Youssef's store gets the dataset's approval history (see approval-seed.ts). */
export { ensureApprovalsSeeded };

/** Tests and the demo's "reset" start again from the dataset (or a given state). */
export async function resetState(state: PaymentsState = loadDatasetState()): Promise<PaymentsState> {
  const g = globalThis as Holder;
  g[KEY] = state;
  await reseedApprovals();
  return state;
}
