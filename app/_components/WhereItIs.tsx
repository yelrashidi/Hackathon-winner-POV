import { Pill } from "./ui";

/** An employee's bill status in plain words (features/invoices plainStatus), coloured by how far along it is. */
export function WhereItIs({ text }: { text: string }) {
  const tone = text === "paid" ? "emerald" : text === "rejected" ? "red" : text.startsWith("waiting") ? "amber" : text === "in checks" ? "slate" : "sky";
  return <Pill tone={tone}>{text}</Pill>;
}
