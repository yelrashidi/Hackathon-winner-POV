import type { Metadata } from "next";
import { getCurrentUser } from "@/server/session/current-user";
import { listUsers } from "@/server/session/users";
import { NotForYourRole } from "../_components/NotForYourRole";
import { PageHeader } from "../_components/PageHeader";
import { canSeePage, dashboardRole, pageByKey } from "../_lib/access";
import { listDepartments, listTaxCodes } from "../_lib/reference-data";
import { UploadWorkbench } from "./_components/UploadWorkbench";

export const metadata: Metadata = { title: "Upload invoices" };

export default async function UploadPage() {
  const user = await getCurrentUser();
  const role = dashboardRole(user);
  if (!canSeePage(role, "upload")) return <NotForYourRole page={pageByKey("upload")} user={user} />;

  const people = listUsers()
    .filter((u) => u.status !== "terminated")
    .sort((a, b) => a.fullName.localeCompare(b.fullName))
    .map((u) => ({ value: u.id, label: `${u.fullName} · ${u.title}` }));

  return (
    <>
      <PageHeader
        title="Upload invoices"
        description="Drop supplier invoices here. Check each one against the original, fix anything that's wrong, then confirm."
      />
      <UploadWorkbench people={people} departments={listDepartments()} taxCodes={listTaxCodes()} />
    </>
  );
}
