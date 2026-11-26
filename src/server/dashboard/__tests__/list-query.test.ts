import { describe, expect, it } from "vitest";
import { matchesSearch, parseQueueSort, searchAndSort, type ListKey } from "../list-query";

// The work-queue search + sort (Checks, Duplicates, Payments overview). Rows are built here.

type Row = { id: string; vendor: string | null; number: string | null; date: string | null };
const key = (r: Row): ListKey => ({ text: [r.vendor, r.number, r.id], vendor: r.vendor, date: r.date, id: r.id });

const rows: Row[] = [
  { id: "A-3", vendor: "beacon Ltd.", number: "ST-4471", date: "2026-11-02" },
  { id: "A-1", vendor: "Zephyr Inc.", number: "Z-1", date: "2026-11-20" },
  { id: "A-4", vendor: null, number: null, date: null }, // an unread document
  { id: "A-2", vendor: "Alpenglow", number: "AL-9", date: "2026-11-20" },
  { id: "A-5", vendor: "Écluse Co.", number: "E-5", date: "2026-10-01" },
];
const ids = (sort: Parameters<typeof searchAndSort>[1]["sort"], search?: string) => searchAndSort(rows, { sort, search }, key).map((r) => r.id);

describe("work-queue sort", () => {
  it("default keeps the page's own order (e.g. Checks' most urgent first)", () => {
    expect(ids("default")).toEqual(["A-3", "A-1", "A-4", "A-2", "A-5"]);
  });

  it("newest / oldest by date, rows without a date last, same-day ties by id", () => {
    expect(ids("newest")).toEqual(["A-2", "A-1", "A-3", "A-5", "A-4"]);
    expect(ids("oldest")).toEqual(["A-5", "A-3", "A-1", "A-2", "A-4"]);
  });

  it("vendor A to Z / Z to A ignore case and accents; rows with no vendor last", () => {
    expect(ids("vendor_az")).toEqual(["A-2", "A-3", "A-5", "A-1", "A-4"]);
    expect(ids("vendor_za")).toEqual(["A-1", "A-5", "A-3", "A-2", "A-4"]);
  });

  it("does not reorder the caller's array", () => {
    const before = rows.map((r) => r.id);
    searchAndSort(rows, { sort: "vendor_az" }, key);
    expect(rows.map((r) => r.id)).toEqual(before);
  });

  it("an unknown or missing ?sort= falls back to the page's default", () => {
    expect(parseQueueSort(undefined)).toBe("default");
    expect(parseQueueSort("amount")).toBe("default");
    expect(parseQueueSort("vendor_za")).toBe("vendor_za");
  });
});

describe("work-queue search", () => {
  it("matches vendor, invoice number or id, case-insensitive, part of a word", () => {
    expect(ids("default", "ZEPH")).toEqual(["A-1"]);
    expect(ids("default", "al-9")).toEqual(["A-2"]);
    expect(ids("default", "a-5")).toEqual(["A-5"]);
  });

  it("ignores punctuation and spaces, so a reformatted number still matches (ST4471 → ST-4471)", () => {
    expect(ids("default", "ST4471")).toEqual(["A-3"]);
    expect(ids("default", "st 4471")).toEqual(["A-3"]);
  });

  it("blank search matches everything; no match is an empty list; search and sort combine", () => {
    expect(ids("default", "   ")).toHaveLength(rows.length);
    expect(ids("default", "nothing-like-this")).toEqual([]);
    expect(ids("oldest", "a-")).toEqual(["A-5", "A-3", "A-1", "A-2", "A-4"]);
  });

  it("a row with no texts never matches a real search", () => {
    expect(matchesSearch({ text: [null, undefined], vendor: null, date: null, id: "" }, "x")).toBe(false);
  });
});
