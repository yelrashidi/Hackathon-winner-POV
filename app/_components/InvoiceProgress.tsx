import type { Actor } from "@/contracts/actor";
import { Forbidden } from "@/server/core/authorize";
import { stepRoleLabel } from "@/server/dashboard/approvals";
import { getInvoiceRecord } from "@/server/features/invoices";
import { WhoDidWhat } from "./WhoDidWhat";

/**
 * The live "who did what" for an invoice still being processed (Checks, Approvals, Payments): who
 * requested it, who checked it, who approved so far, and who it is waiting on. Shown only when the
 * viewer may see this invoice (features/invoices scope); otherwise nothing.
 */
export async function InvoiceProgress({ actor, invoiceId }: { actor: Actor; invoiceId: string }) {
  let record;
  try {
    record = await getInvoiceRecord(actor, invoiceId, { stepLabel: stepRoleLabel });
  } catch (err) {
    if (err instanceof Forbidden) return null;
    throw err;
  }
  if (!record) return null;
  return <WhoDidWhat steps={record.chain} title="Progress — who did what" description="Live: who requested it, who checked it, who approved so far, and who it is waiting on." />;
}
