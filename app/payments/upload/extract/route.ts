import { getCurrentUser } from "@/server/session/current-user";
import { extractInvoice } from "../../_lib/extraction-adapter";
import { canUpload, fileProblem } from "../../_lib/upload-rules";

// One file per request (a whole batch in one request could time out on serverless).
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!canUpload(user?.role)) {
    return Response.json({ error: "Only AP Clerks and Controllers can upload invoices." }, { status: 403 });
  }

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "No file was sent." }, { status: 400 });
  const problem = fileProblem(file);
  if (problem) return Response.json({ error: problem }, { status: 400 });

  return Response.json(await extractInvoice(file));
}
