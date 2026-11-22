import type { Metadata } from "next";
import { reviewOptions } from "@/server/dashboard/checks";
import { getViewer } from "@/server/session/current-user";
import { NotForYourRole } from "../../_components/NotForYourRole";
import { Notice, PageHeader } from "../../_components/ui";
import { canSee } from "../../_lib/nav";
import { UploadWorkbench } from "./_components/UploadWorkbench";

export const metadata: Metadata = { title: "Upload invoices" };

export default async function UploadPage() {
  const viewer = await getViewer();
  if (!canSee(viewer?.role ?? null, "upload")) return <NotForYourRole sectionKey="upload" viewer={viewer} />;
  const options = await reviewOptions(viewer!.actor);
  const modelOn = Boolean(process.env.ANTHROPIC_API_KEY);

  return (
    <>
      <PageHeader
        title="Upload invoices"
        description="Drop supplier invoices here. Each file is read, then you check it against the original, fix anything that's wrong and confirm. Confirmed invoices go straight into Checks with validation and coding done."
      />
      {!modelOn && (
        <Notice tone="info" title="Reading is off in this demo">
          No extraction model is configured (ANTHROPIC_API_KEY), so each file opens for manual entry — never a guess. Set the key to have Claude read PDFs and scans.
        </Notice>
      )}
      <UploadWorkbench people={options.people} departments={options.departments} taxCodes={options.taxCodes} />
    </>
  );
}
