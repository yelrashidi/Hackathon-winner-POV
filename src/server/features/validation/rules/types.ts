import type { Flag } from "@/contracts/flag";
import type { ValidationInput } from "@/contracts/validation";
import type { ValidationContext } from "../context";
import type { Derived } from "../derive";

/** A rule is a pure function: same invoice + same reference data → same flags. */
export type Rule = (input: ValidationInput, ctx: ValidationContext, d: Derived) => Flag[];
