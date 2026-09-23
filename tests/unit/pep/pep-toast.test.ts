import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PEP_LINES } from "@/lib/domain/pep-talk-lines";
import { PEP_DAY_KEY, PEP_SETTING_KEY, localDate, readPepDay } from "@/lib/pep/storage";

const { toastSpy } = vi.hoisted(() => ({ toastSpy: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastSpy }));

const { cheerOutcome } = await import("@/components/pep/pep-toast");

/** The unit project runs in node, so the storage the pep module expects has to be supplied. */
function installStorage(): Map<string, string> {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: storage, addEventListener() {}, removeEventListener() {} },
  });
  return store;
}

let store: Map<string, string>;

beforeEach(() => {
  store = installStorage();
  toastSpy.mockClear();
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
});

function log(callId: string, outcome: "NO_ANSWER" | "NOT_INTERESTED" = "NO_ANSWER") {
  cheerOutcome({ outcome, business: "Kompose Hotel Sarasota", callId });
}

describe("cheerOutcome", () => {
  it("always greets the first logged call of the day", () => {
    log("call-1");
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(typeof toastSpy.mock.calls[0]?.[0]).toBe("string");
    expect(toastSpy.mock.calls[0]?.[0]).not.toMatch(/[{}]/);
  });

  it("says nothing at all when the agent turned it off, and counts nothing either", () => {
    store.set(PEP_SETTING_KEY, "off");
    for (let index = 0; index < 5; index += 1) log(`call-${index}`);
    expect(toastSpy).not.toHaveBeenCalled();
    expect(readPepDay(localDate()).calls).toBe(0);
  });

  it("counts every logged call, including the quiet ones", () => {
    for (let index = 0; index < 9; index += 1) log(`call-${index}`);
    expect(readPepDay(localDate()).calls).toBe(9);
    expect(toastSpy.mock.calls.length).toBeLessThan(9);
  });

  it("celebrates the tenth call whatever the outcome was", () => {
    for (let index = 0; index < 9; index += 1) log(`call-${index}`);
    toastSpy.mockClear();
    log("call-9", "NOT_INTERESTED");

    const milestone = PEP_LINES.filter((line) => line.bucket === "milestone:ten");
    const shown = String(toastSpy.mock.calls[0]?.[0] ?? "");
    const matches = milestone.some((line) => {
      const pattern = line.text.split("{dials}").join("10");
      return pattern === shown;
    });
    expect(matches, `"${shown}" is not a tenth-call line`).toBe(true);
  });

  it("keeps quiet rather than throwing when storage is unavailable", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          getItem() {
            throw new Error("blocked");
          },
          setItem() {
            throw new Error("blocked");
          },
        },
        addEventListener() {},
        removeEventListener() {},
      },
    });
    expect(() => log("call-x")).not.toThrow();
  });

  it("works through the whole bucket before repeating itself", () => {
    // Repeats are deliberate once a bucket is spent: a line an agent saw this morning beats a blank
    // space. What must not happen is the same line twice while fresh ones are still available.
    const available = PEP_LINES.filter((line) => line.bucket === "outcome:NO_ANSWER").length;
    const seen = new Set<string>();
    for (let index = 0; index < 40; index += 1) log(`call-${index}`);
    for (const call of toastSpy.mock.calls) seen.add(String(call[0]));

    expect(toastSpy.mock.calls.length).toBeGreaterThan(available);
    expect(seen.size).toBeGreaterThanOrEqual(available);
    expect(store.get(PEP_DAY_KEY)).toContain("recent");
  });
});
