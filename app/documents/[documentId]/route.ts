import { eq } from "drizzle-orm";
import { invoices } from "@/server/db/schema";
import { ensureDb } from "@/server/demo/database";
import { inScope, invoiceScope } from "@/server/features/invoices";
import { readDocumentFile } from "@/server/pipeline";
import { getViewer } from "@/server/session/current-user";
import { canSee } from "../../_lib/nav";

// The original file of an invoice, for the review screen, the invoice record and the audit trail.
// Same scope as the invoice itself (features/invoices: managers see their own department's); a file
// not yet tied to an invoice (an inbox attachment) is for the people who triage the inbox. Never
// cached publicly.
export async function GET(_request: Request, { params }: RouteContext<"/documents/[documentId]">) {
  const db = await ensureDb();
  const viewer = await getViewer();
  if (!viewer) return new Response("Sign in to see invoice documents.", { status: 403 });
  const { documentId } = await params;
  const [inv] = await db.select({ departmentId: invoices.departmentId, requesterId: invoices.requesterId }).from(invoices).where(eq(invoices.documentId, documentId)).limit(1);
  const allowed = inv ? inScope(await invoiceScope(viewer.actor, { db }), inv) : canSee(viewer.role, "inbox") || canSee(viewer.role, "audit");
  if (!allowed) return new Response("This document belongs to an invoice you cannot see.", { status: 403 });
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
