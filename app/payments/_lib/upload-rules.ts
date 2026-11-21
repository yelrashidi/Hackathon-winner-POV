// What the upload screen accepts. Shared by the browser (to warn early) and the server (to enforce).

export const ACCEPTED_TYPES = ["application/pdf", "image/png", "image/jpeg"];
export const ACCEPT_ATTRIBUTE = ".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg";
/** 4 MB: fits Vercel's request limit without changing next.config.ts. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** Below this extraction confidence a field is marked "Check this". */
export const CHECK_THIS_BELOW = 0.8;

/** Why a file can't be uploaded, or null if it's fine. */
export function fileProblem(file: { type: string; size: number }): string | null {
  if (!ACCEPTED_TYPES.includes(file.type)) return "Only PDF, PNG or JPG files can be uploaded.";
  if (file.size > MAX_FILE_BYTES) return "Files must be 4 MB or smaller.";
  return null;
}

/** AP Clerks and Controllers upload and confirm invoices. */
export function canUpload(role: string | undefined): boolean {
  return role === "ap_clerk" || role === "controller_admin";
}
