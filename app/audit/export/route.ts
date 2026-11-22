import { Forbidden } from "@/server/core/authorize";
import { ensureDb } from "@/server/demo/database";
import { exportAuditCsv } from "@/server/features/audit";
import { getViewer } from "@/server/session/current-user";

// The audit log as CSV (the Auditor and the Admin): ?from=YYYY-MM-DD&to=YYYY-MM-DD&invoiceId=…
export async function GET(request: Request) {
  await ensureDb();
  const viewer = await getViewer();
  if (!viewer) return new Response("Sign in first.", { status: 403 });
  const url = new URL(request.url);
  const day = (k: string) => (/^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get(k) ?? "") ? url.searchParams.get(k)! : undefined);
  try {
    const out = await exportAuditCsv(viewer.actor, { from: day("from"), to: day("to"), invoiceId: url.searchParams.get("invoiceId") || undefined });
    return new Response(out.csv, {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${out.fileName.replace(/"/g, "")}"`, "Cache-Control": "private, no-store" },
    });
  } catch (err) {
    if (err instanceof Forbidden) return new Response(err.reason, { status: 403 });
    throw err;
  }
}
