// TEMP: db — one in-memory state for the whole server process. It resets when the server
// restarts. Kept on globalThis so Next's dev reloads don't wipe it between requests.

import type { PaymentsState } from "../types";
import { loadDatasetState } from "./load";

const KEY = Symbol.for("harborline.payments.state");
type Holder = { [KEY]?: PaymentsState };

export function getState(): PaymentsState {
  const g = globalThis as Holder;
  g[KEY] ??= loadDatasetState();
  return g[KEY];
}

/** Tests and the demo's "reset" use this to start again from the dataset (or a given state). */
export function resetState(state: PaymentsState = loadDatasetState()): PaymentsState {
  (globalThis as Holder)[KEY] = state;
  return state;
}
