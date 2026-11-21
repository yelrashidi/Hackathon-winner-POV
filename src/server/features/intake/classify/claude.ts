import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { CLASSIFIER_SYSTEM_PROMPT, LlmVerdict } from "./prompt";

/**
 * The email-text classifier: used only for emails WITHOUT a readable document that the rules
 * could not settle (e.g. a known vendor writing with no keywords). Documents are read by
 * extraction, not here. Credentials: ANTHROPIC_API_KEY. Model override: INTAKE_CLASSIFIER_MODEL.
 * Effort "low" (triage); Zod structured output; server-side refusal fallback.
 */

export interface LlmClassifierInput {
  text: string;
}

export type LlmClassifier = (input: LlmClassifierInput) => Promise<LlmVerdict>;

export function createClaudeClassifier(client: Anthropic = new Anthropic()): LlmClassifier {
  const model = process.env.INTAKE_CLASSIFIER_MODEL?.trim() || "claude-opus-5-5";

  return async ({ text }) => {
    const response = await client.beta.messages.parse({
      model,
      max_tokens: 4096,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: CLASSIFIER_SYSTEM_PROMPT,
      messages: [{ role: "user", content: text }],
      output_config: { effort: "low", format: betaZodOutputFormat(LlmVerdict) },
    });

    if (response.stop_reason === "refusal") {
      throw new Error(`Claude declined to classify (${response.stop_details?.category ?? "no category"})`);
    }
    if (response.stop_reason === "max_tokens") throw new Error("Claude reply was cut off (max_tokens)");
    if (!response.parsed_output) throw new Error("Claude reply did not match the classification schema");
    return response.parsed_output;
  };
}
