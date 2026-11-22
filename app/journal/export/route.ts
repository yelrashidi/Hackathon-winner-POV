import { Forbidden } from "@/server/core/authorize";
import { ensureDb } from "@/server/demo/database";
import { exportJournal, JournalExportError } from "@/server/features/journal";
import { getViewer } from "@/server/session/current-user";

// Download the journal CSV. A POST (not a link): it records the export in the audit trail and marks
// those bills and payments as posted, so the next "only new" export skips them. The actor comes from
// the session; exportJournal() runs authorize("journal.export") itself.
export async function POST(request: Request) {
  await ensureDb();
  const viewer = await getViewer();
  if (!viewer) return new Response("Sign in first.", { status: 403 });
  const form = await request.formData();
  const text = (k: string) => String(form.get(k) ?? "");
  const query = {
    from: text("from") || undefined,
    to: text("to") || undefined,
    bills: text("bills") === "1",
    payments: text("payments") === "1",
    onlyNew: text("onlyNew") === "1",
  };
  try {
    const out = await exportJournal(viewer.actor, query);
    return new Response(out.csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${out.fileName.replace(/"/g, "")}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    if (err instanceof Forbidden) return new Response(err.reason, { status: 403 });
    if (err instanceof JournalExportError) {
      const back = new URL("/journal", request.url);
      for (const [k, v] of Object.entries({ f: "1", from: query.from, to: query.to, bills: query.bills ? "1" : "", payments: query.payments ? "1" : "", onlyNew: query.onlyNew ? "1" : "", error: err.message })) if (v) back.searchParams.set(k, v);
      return Response.redirect(back, 303);
    }
    throw err;
  }
}
