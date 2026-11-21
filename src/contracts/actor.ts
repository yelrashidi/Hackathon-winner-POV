import { z } from "zod";

/**
 * Who is doing something. Built on the SERVER from the session (never from a role or id the
 * browser sent) and passed to authorize(), fire() and the audit emitter.
 *
 * A delegate acts as themselves: `userId` = the delegate, `onBehalfOf` = the absent person
 * (roles-and-permissions.md rule 4). Automated steps use the seeded `system` user.
 */
export const ActorRole = z.enum(["employee", "ap_clerk", "approver", "finance_manager", "controller_admin", "auditor", "system"]);
export type ActorRole = z.infer<typeof ActorRole>;

export const Actor = z.object({
  userId: z.string().min(1),
  role: ActorRole,
  onBehalfOf: z.string().min(1).nullable().default(null),
});
export type Actor = z.input<typeof Actor>;

/** The seeded user automated steps act as (extraction, validation, seed). Not a person; cannot log in. */
export const SYSTEM_USER_ID = "SYSTEM";
export const SYSTEM_ACTOR: Actor = { userId: SYSTEM_USER_ID, role: "system", onBehalfOf: null };
