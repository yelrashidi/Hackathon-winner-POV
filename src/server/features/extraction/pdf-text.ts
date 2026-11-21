import { extractText, getDocumentProxy } from "unpdf";

/**
 * The PDF's embedded text layer, read locally (no API, nothing leaves the machine).
 * Machine-generated PDFs have one; scans and photos do not (→ the model reads the image).
 */
export const MIN_TEXT_LAYER_CHARS = 80;

export interface TextLayer {
  text: string;
  pages: number;
}

export async function readPdfTextLayer(bytes: Buffer): Promise<TextLayer | null> {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { totalPages, text } = await extractText(pdf, { mergePages: true });
    return { text: text.trim(), pages: totalPages };
  } catch {
    return null; // encrypted or corrupt: the model gets the raw PDF instead
  }
}

export function hasUsableText(layer: TextLayer | null): layer is TextLayer {
  return layer !== null && layer.text.replace(/\s+/g, "").length >= MIN_TEXT_LAYER_CHARS;
}
