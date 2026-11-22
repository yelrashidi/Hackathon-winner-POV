import type { Metadata } from "next";

// The frame (top bar, sidebar, theme) is the app's own (app/layout.tsx); payments pages sit inside it.
export const metadata: Metadata = { title: { default: "Payments", template: "%s · Brim AP" } };

export default function PaymentsLayout({ children }: LayoutProps<"/payments">) {
  return children;
}
