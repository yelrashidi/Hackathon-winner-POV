import Link from "next/link";
import type { DirectoryUser } from "@/server/session/users";
import { ROLE_LABEL, type PaymentsPage } from "../_lib/access";

/** Shown instead of a page the signed-in person's role doesn't include. Checked on the server. */
export function NotForYourRole({ page, user }: { page: PaymentsPage; user: DirectoryUser | null }) {
  return (
    <div className="mx-auto mt-10 max-w-lg rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
      <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-500">
        <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5" aria-hidden>
          <path
            fillRule="evenodd"
            d="M10 1a4.5 4.5 0 0 0-4.5 4.5V9H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-.5V5.5A4.5 4.5 0 0 0 10 1Zm3 8V5.5a3 3 0 1 0-6 0V9h6Z"
            clipRule="evenodd"
          />
        </svg>
      </div>
      <h1 className="mt-4 text-lg font-semibold text-slate-900">{page.label} is for {page.forWhom}</h1>
      <p className="mt-2 text-sm text-slate-500">
        {user
          ? `You're viewing as ${user.fullName} (${ROLE_LABEL[user.role]}).`
          : "You haven't picked who you are yet."}{" "}
        Switch person in the top-right, or go back to the overview.
      </p>
      <Link
        href="/payments"
        className="mt-6 inline-flex rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
      >
        Go to overview
      </Link>
    </div>
  );
}
