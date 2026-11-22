"use server";

// The two decisions on a possible duplicate. The acting person ALWAYS comes from the server
// session; the duplicates service runs authorize() again, so calling this as the wrong role fails
// on the server even if the button were shown.

import { refresh } from "next/cache";
import type { Actor } from "@/contracts/actor";
import { Forbidden } from "@/server/core/authorize";
import { TransitionError } from "@/server/core/fire";
import { confirmDuplicate, dismissDuplicate, DuplicateActionError } from "@/server/features/duplicates";
import { FlagActionError } from "@/server/features/validation";
import { getCurrentUser } from "@/server/session/current-user";
import type { FormState } from "../actions";

async function actor(): Promise<Actor | null> {
  const user = await getCurrentUser();
  return user ? { userId: user.id, role: user.role, onBehalfOf: null } : null;
}

const known = (err: unknown) => err instanceof Forbidden || err instanceof DuplicateActionError || err instanceof FlagActionError || err instanceof TransitionError;

async function run(form: FormData, fn: (who: Actor, flagId: number, note: string) => Promise<unknown>, done: string): Promise<FormState> {
  const who = await actor();
  if (!who) return { ok: false, messages: ["Pick who you are in the top-right first."] };
  const flagId = Number(form.get("flagId"));
  if (!Number.isInteger(flagId)) return { ok: false, messages: ["Unknown flag."] };
  try {
    await fn(who, flagId, String(form.get("note") ?? ""));
  } catch (err) {
    if (known(err)) return { ok: false, messages: [(err as Error).message] };
    throw err;
  }
  refresh();
  return { ok: true, messages: [done] };
}

/** "Yes, same bill": the invoice is voided (or closed when it was paid by card). */
export async function confirmDuplicateAction(_: FormState, form: FormData): Promise<FormState> {
  return run(form, (who, id, note) => confirmDuplicate(who, id, note), "Confirmed. The invoice was taken out of the payable queue.");
}

/** "No, different bill": the flag is overridden with the note and stops blocking. */
export async function dismissDuplicateAction(_: FormState, form: FormData): Promise<FormState> {
  return run(form, (who, id, note) => dismissDuplicate(who, id, note), "Marked as not a duplicate.");
}
