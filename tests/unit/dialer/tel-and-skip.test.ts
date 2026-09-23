import { describe, expect, it } from "vitest";
import {
  PENDING_TEL_MAX_AGE_MS,
  PENDING_TEL_STORAGE_KEY,
  clearPendingTel,
  newClientRequestId,
  parsePendingTel,
  pendingTelWrapUp,
  readPendingTel,
  shouldOpenTelOutcome,
  writePendingTel,
  type PendingTel,
} from "@/lib/dialer/drivers/tel";
import {
  MAX_SKIP_IDS,
  appendSkip,
  leadFlowHref,
  nextLeadHref,
  parseSkipParam,
} from "@/lib/dialer/skip-list";

const LEAD = "11111111-1111-4111-8111-111111111111";
const REQ = "33333333-3333-4333-8333-333333333333";
const CALL = "22222222-2222-4222-8222-222222222222";
const NOW = 1_800_000_000_000;

function memoryStore() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

describe("pending tel call", () => {
  const USER = "44444444-4444-4444-8444-444444444444";
  const pending: PendingTel = {
    userId: USER,
    leadId: LEAD,
    label: "Acme",
    clientRequestId: REQ,
    startedAt: NOW - 5_000,
    stage: "calling",
  };

  it("round-trips through storage", () => {
    const store = memoryStore();
    writePendingTel(pending, store);
    expect(store.map.has(PENDING_TEL_STORAGE_KEY)).toBe(true);
    expect(readPendingTel(NOW, USER, store)).toEqual(pending);
    clearPendingTel(store);
    expect(readPendingTel(NOW, USER, store)).toBeNull();
  });

  it("is never restored for another signed-in user", () => {
    const store = memoryStore();
    writePendingTel(pending, store);
    expect(readPendingTel(NOW, "55555555-5555-4555-8555-555555555555", store)).toBeNull();
  });

  it("rejects malformed, tampered and expired values", () => {
    const parse = (value: unknown) => parsePendingTel(JSON.stringify(value), NOW, USER);
    expect(parsePendingTel(null, NOW, USER)).toBeNull();
    expect(parsePendingTel("not json", NOW, USER)).toBeNull();
    expect(parsePendingTel("[]", NOW, USER)).toBeNull();
    expect(parse({ ...pending, userId: undefined })).toBeNull();
    expect(parse({ ...pending, leadId: "x" })).toBeNull();
    expect(parse({ ...pending, clientRequestId: 5 })).toBeNull();
    expect(parse({ ...pending, stage: "other" })).toBeNull();
    expect(parse({ ...pending, startedAt: "yesterday" })).toBeNull();
    expect(parse({ ...pending, startedAt: NOW - PENDING_TEL_MAX_AGE_MS - 1 })).toBeNull();
    expect(parse({ ...pending, startedAt: NOW + 3_600_000 })).toBeNull();
    expect(parse({ ...pending, stage: "wrap-up" })).toMatchObject({ stage: "wrap-up" });
  });

  it("generates v4 request ids, with or without crypto.randomUUID", () => {
    const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(newClientRequestId()).toMatch(V4);
    const original = globalThis.crypto.randomUUID;
    try {
      Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined, configurable: true });
      const ids = new Set(Array.from({ length: 50 }, () => newClientRequestId()));
      expect(ids.size).toBe(50);
      for (const id of ids) expect(id).toMatch(V4);
    } finally {
      Object.defineProperty(globalThis.crypto, "randomUUID", { value: original, configurable: true });
    }
  });

  it("survives storage that throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readPendingTel(NOW, pending.userId, broken)).toBeNull();
    expect(() => writePendingTel(pending, broken)).not.toThrow();
    expect(() => clearPendingTel(broken)).not.toThrow();
  });

  it("opens the outcome sheet only after the phone app had time to take over", () => {
    expect(shouldOpenTelOutcome({ startedAt: NOW }, NOW + 200)).toBe(false);
    expect(shouldOpenTelOutcome({ startedAt: NOW }, NOW + 999)).toBe(false);
    expect(shouldOpenTelOutcome({ startedAt: NOW }, NOW + 1_000)).toBe(true);
  });

  it("builds a TEL wrap-up keyed by the client request id", () => {
    expect(pendingTelWrapUp(pending)).toEqual({
      leadId: LEAD,
      callId: null,
      clientRequestId: REQ,
      mode: "TEL",
      endReason: "completed",
      preselectedOutcome: null,
      label: "Acme",
    });
  });

  it("restores a manual phone call with its server call ID and no lead", () => {
    const manual = { ...pending, leadId: null, callId: CALL, label: "+1 (212) 555-0123" };
    const restored = parsePendingTel(JSON.stringify(manual), NOW, USER);
    expect(restored).toEqual(manual);
    expect(pendingTelWrapUp(restored!)).toMatchObject({ leadId: null, callId: CALL, mode: "TEL" });
  });

  it("rejects a no-lead phone call without a valid server call ID", () => {
    for (const callId of [undefined, null, "not-a-uuid"]) {
      expect(parsePendingTel(JSON.stringify({ ...pending, leadId: null, callId }), NOW, USER)).toBeNull();
    }
    expect(parsePendingTel(JSON.stringify({ ...pending, callId: "not-a-uuid" }), NOW, USER)).toBeNull();
  });
});

describe("skip list", () => {
  const id = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

  it("parses, validates, lower-cases and de-duplicates", () => {
    const upper = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";
    expect(parseSkipParam(undefined)).toEqual([]);
    expect(parseSkipParam("")).toEqual([]);
    expect(parseSkipParam(`${LEAD}, nope ,${upper},${LEAD},'; drop table`)).toEqual([LEAD, upper.toLowerCase()]);
    expect(parseSkipParam([LEAD, REQ])).toEqual([LEAD, REQ]);
  });

  it("keeps the most recent 200", () => {
    const ids = Array.from({ length: 250 }, (_, i) => id(i));
    const parsed = parseSkipParam(ids.join(","));
    expect(parsed).toHaveLength(MAX_SKIP_IDS);
    expect(parsed[0]).toBe(id(50));
    expect(parsed.at(-1)).toBe(id(249));
    expect(appendSkip(parsed, id(999)).at(-1)).toBe(id(999));
    expect(appendSkip(parsed, id(999))).toHaveLength(MAX_SKIP_IDS);
  });

  it("appendSkip ignores invalid and repeated ids", () => {
    expect(appendSkip([LEAD], "bad")).toEqual([LEAD]);
    expect(appendSkip([LEAD], LEAD)).toEqual([LEAD]);
    expect(appendSkip([LEAD], REQ)).toEqual([LEAD, REQ]);
  });

  it("builds hrefs", () => {
    expect(nextLeadHref([])).toBe("/next");
    expect(nextLeadHref([LEAD, REQ])).toBe(`/next?skip=${LEAD},${REQ}`);
    expect(leadFlowHref(LEAD, [])).toBe(`/leads/${LEAD}?flow=next`);
    expect(leadFlowHref(LEAD, [REQ], "OVERDUE")).toBe(`/leads/${LEAD}?flow=next&skip=${REQ}&reason=OVERDUE`);
    expect(leadFlowHref(LEAD, [REQ], "<script>")).toBe(`/leads/${LEAD}?flow=next&skip=${REQ}`);
  });
});
