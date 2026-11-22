export const vendorTone = (s: string) => (s === "active" ? "emerald" : s === "on_hold" ? "red" : "amber") as "emerald" | "red" | "amber";
