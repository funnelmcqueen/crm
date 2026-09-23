import { describe, expect, it } from "vitest";
import { z } from "zod";
import { clearWorkspaceDrafts, draftKey, readDraft, removeDraft, writeDraft } from "@/lib/dialer/workspace-drafts";

function store() {
  const rows = new Map<string, string>();
  return { get length() { return rows.size; }, key: (i: number) => [...rows.keys()][i] ?? null,
    getItem: (k: string) => rows.get(k) ?? null, setItem: (k: string, v: string) => { rows.set(k, v); },
    removeItem: (k: string) => { rows.delete(k); } };
}
const NOW = 1_800_000_000_000;
describe("workspace draft recovery", () => {
  it("recovers exact notes only for the same user and lead, then removes saved drafts", () => {
    const memory = store();
    const key = draftKey("a", "lead", "one");
    expect(writeDraft(key, "Owner\nCall Friday", memory, NOW)).toBe(true);
    expect(readDraft(key, z.string(), memory, NOW)).toBe("Owner\nCall Friday");
    expect(readDraft(draftKey("b", "lead", "one"), z.string(), memory, NOW)).toBeNull();
    expect(readDraft(draftKey("a", "lead", "two"), z.string(), memory, NOW)).toBeNull();
    removeDraft(key, memory);
    expect(readDraft(key, z.string(), memory, NOW)).toBeNull();
  });
  it("rejects expired, future, malformed and invalid drafts", () => {
    const memory = store(); const key = draftKey("a", "lead", "one");
    writeDraft(key, "old", memory, NOW - 13 * 60 * 60 * 1000);
    expect(readDraft(key, z.string(), memory, NOW)).toBeNull();
    writeDraft(key, "future", memory, NOW + 120_000);
    expect(readDraft(key, z.string(), memory, NOW)).toBeNull();
    memory.setItem(key, "{");
    expect(readDraft(key, z.string(), memory, NOW)).toBeNull();
    writeDraft(key, { notes: 123 }, memory, NOW);
    expect(readDraft(key, z.object({ notes: z.string() }), memory, NOW)).toBeNull();
  });
  it("sign-out clears workspace drafts without touching session cookies or other preferences", () => {
    const memory = store();
    writeDraft(draftKey("a", "lead", "one"), "private", memory, NOW);
    writeDraft(draftKey("a", "outcome", "call"), "private", memory, NOW);
    memory.setItem("other", "keep");
    clearWorkspaceDrafts(memory);
    expect(memory.length).toBe(1); expect(memory.getItem("other")).toBe("keep");
  });
  it("returns a storage failure without throwing, so the form can warn and remain editable", () => {
    const memory = store(); memory.setItem = () => { throw new Error("quota"); };
    expect(writeDraft("x", "note", memory, NOW)).toBe(false);
    expect(readDraft("x", z.string(), memory, NOW)).toBe("note");
    removeDraft("x", memory);
    expect(readDraft("x", z.string(), memory, NOW)).toBeNull();
  });
  it("retains drafts across in-app navigation without browser storage and clears them on sign-out", () => {
    writeDraft("memory-only", "Keep these notes", null, NOW);
    expect(readDraft("memory-only", z.string(), null, NOW)).toBe("Keep these notes");
    clearWorkspaceDrafts(null);
    expect(readDraft("memory-only", z.string(), null, NOW)).toBeNull();
  });
  it("does not resurrect saved notes when deleting from browser storage fails", () => {
    const memory = store();
    writeDraft("saved", "Old notes", memory, NOW);
    memory.removeItem = () => { throw new Error("storage denied"); };
    removeDraft("saved", memory);
    expect(readDraft("saved", z.string(), memory, NOW)).toBeNull();
  });
});
