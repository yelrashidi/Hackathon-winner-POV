import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { extractionSystemPrompt, llmExtractionSchema, type LlmExtraction } from "./prompt";
import type { TaxCodeRef } from "./tax-codes";

/**
 * The one Claude call extraction makes per document.
 * - Text-layer PDFs are sent as text (cheaper, faster); scans and image-only PDFs as the
 *   PDF/image itself so Claude reads the page visually.
 * - Effort "medium": accuracy matters more here than in triage.
 * - Structured output validated by the SDK against the Zod schema; refusals fall back server-side.
 * Model override: EXTRACTION_MODEL.
 */

export type ExtractorInput =
  | { kind: "text"; text: string; filename: string }
  | { kind: "pdf"; base64: string; filename: string }
  | { kind: "image"; base64: string; mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif"; filename: string };

export type LlmExtractor = (input: ExtractorInput) => Promise<LlmExtraction>;

export const EXTRACTOR_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function createClaudeExtractor(taxCodes: readonly TaxCodeRef[], client: Anthropic = new Anthropic()): LlmExtractor {
  const model = process.env.EXTRACTION_MODEL?.trim() || "claude-opus-5-5";
  const system = extractionSystemPrompt(taxCodes);
  const schema = llmExtractionSchema(taxCodes);

  return async (input) => {
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    if (input.kind === "pdf") {
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: input.base64 } });
      content.push({ type: "text", text: `Read the attached document (file name: ${input.filename}).` });
    } else if (input.kind === "image") {
      content.push({ type: "image", source: { type: "base64", media_type: input.mime, data: input.base64 } });
      content.push({ type: "text", text: `Read the attached scanned document (file name: ${input.filename}).` });
    } else {
      content.push({ type: "text", text: `Text layer of the PDF "${input.filename}":\n<document>\n${input.text}\n</document>` });
    }

    const response = await client.beta.messages.parse({
      model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system,
      messages: [{ role: "user", content }],
      output_config: { effort: "medium", format: betaZodOutputFormat(schema) },
    });

    if (response.stop_reason === "refusal") {
      throw new Error(`Claude declined to read the document (${response.stop_details?.category ?? "no category"})`);
    }
    if (response.stop_reason === "max_tokens") throw new Error("Claude reply was cut off (max_tokens)");
    if (!response.parsed_output) throw new Error("Claude reply did not match the extraction schema");
    return response.parsed_output;
  };
}
