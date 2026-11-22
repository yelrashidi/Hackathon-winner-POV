import { ensureDb } from "@/server/demo/database";
import { readDocumentFile } from "@/server/pipeline";
import { getViewer } from "@/server/session/current-user";

// The original file of an invoice, for the review screen and the audit trail. Signed-in dashboard
// roles only (every one of them reads the audit trail); nobody else, and never cached publicly.
export async function GET(_request: Request, { params }: RouteContext<"/documents/[documentId]">) {
  await ensureDb();
  const viewer = await getViewer();
  if (!viewer) return new Response("Sign in to see invoice documents.", { status: 403 });
  const { documentId } = await params;
  const file = await readDocumentFile(documentId);
  if (!file) return new Response("This document's file is not available.", { status: 404 });
  return new Response(new Uint8Array(file.bytes), {
    headers: {
      "Content-Type": file.mime,
      "Content-Disposition": `inline; filename="${file.fileName.replace(/"/g, "")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
