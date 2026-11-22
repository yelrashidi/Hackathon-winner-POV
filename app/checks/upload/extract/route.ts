import { can } from "@/server/core/authorize";
import { ensureDb } from "@/server/demo/database";
import { saveUploadedDocument } from "@/server/pipeline";
import { getViewer } from "@/server/session/current-user";
import { extractInvoice } from "../_lib/extraction-adapter";
import { fileProblem } from "../_lib/upload-rules";

// One file per request (a whole batch in one request could time out on serverless). The file is kept
// first (documents row + sha256), so the invoice confirmed from it links to the exact bytes read.
export async function POST(request: Request) {
  await ensureDb();
  const viewer = await getViewer();
  if (!viewer || !can(viewer.actor, "invoice.upload")) {
    return Response.json({ error: `Your role (${viewer?.actor.role ?? "signed out"}) cannot upload invoices.` }, { status: 403 });
  }

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "No file was sent." }, { status: 400 });
  const problem = fileProblem(file);
  if (problem) return Response.json({ error: problem }, { status: 400 });

  const bytes = Buffer.from(await file.arrayBuffer());
  const { documentId } = await saveUploadedDocument({ bytes, fileName: file.name, mime: file.type });
  try {
    return Response.json({ documentId, ...(await extractInvoice({ bytes, name: file.name, type: file.type })) });
  } catch (err) {
    return Response.json({ documentId, status: "failed", reason: err instanceof Error ? err.message : "Extraction failed." });
  }
}
