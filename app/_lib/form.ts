import "server-only";

// What every server action returns to its form: ok + the messages to show (the server's reasons
// when it says no). Known refusals become messages; anything else is a real error and is thrown.

import { refresh } from "next/cache";
import { Forbidden } from "@/server/core/authorize";
import { TransitionError } from "@/server/core/fire";
import { FlagActionError } from "@/server/features/validation";
import { AdminError, ApprovalFlowError, CodingError, IngestError } from "@/server/pipeline";
import { getViewer, type Viewer } from "@/server/session/current-user";

export type FormState = { ok: boolean; messages: string[]; data?: Record<string, string> } | null;

const KNOWN = [Forbidden, TransitionError, FlagActionError, AdminError, ApprovalFlowError, CodingError, IngestError];

export function refusal(err: unknown): string[] | null {
  if (!KNOWN.some((K) => err instanceof K)) return null;
  const e = err as Error & { reasons?: string[]; reason?: string };
  if (e instanceof ApprovalFlowError && e.reasons.length) return e.reasons;
  return [e instanceof Forbidden ? e.reason : e.message];
}

/** Runs one action as the signed-in person. The actor always comes from the session, never the form. */
export async function asViewer(fn: (viewer: Viewer) => Promise<string | string[] | { messages: string[]; data?: Record<string, string> }>): Promise<FormState> {
  const viewer = await getViewer();
  if (!viewer) return { ok: false, messages: ["Pick who you are in the top-right first."] };
  try {
    const out = await fn(viewer);
    refresh();
    if (typeof out === "string") return { ok: true, messages: [out] };
    if (Array.isArray(out)) return { ok: true, messages: out };
    return { ok: true, ...out };
  } catch (err) {
    const messages = refusal(err);
    if (messages) return { ok: false, messages };
    throw err;
  }
}

export const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
