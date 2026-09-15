import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  APP_ERROR_STATUS,
  AppError,
  type AppErrorCode,
  httpError,
  isNextControlFlowError,
  mapPostgrestError,
  runAction,
  toActionResult,
  toHttpResponse,
} from "@/server/errors";

const pg = (code: string, message = "database says no") => ({ code, message, details: null, hint: null });

function nextSignal(digest: string): Error & { digest: string } {
  return Object.assign(new Error(digest), { digest });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AppError", () => {
  it("uses the HTTP statuses from the contract", () => {
    expect(APP_ERROR_STATUS).toEqual({
      unauthorized: 401,
      forbidden: 403,
      not_found: 404,
      validation: 400,
      conflict: 409,
      rate_limited: 429,
      unavailable: 503,
      internal: 500,
    });
    for (const code of Object.keys(APP_ERROR_STATUS) as AppErrorCode[]) {
      const err = new AppError(code);
      expect(err).toBeInstanceOf(Error);
      expect(err.status).toBe(APP_ERROR_STATUS[code]);
      expect(err.message.length).toBeGreaterThan(0);
    }
  });

  it("keeps an explicit user-facing message", () => {
    expect(new AppError("validation", "Business name is required").message).toBe("Business name is required");
  });
});

describe("mapPostgrestError", () => {
  it.each([
    ["P0002", "not_found"],
    ["PGRST116", "not_found"],
    ["42501", "forbidden"],
    ["22023", "validation"],
    ["22P02", "validation"],
    ["23514", "validation"],
    ["23505", "conflict"],
    ["PGRST301", "unauthorized"],
    ["XX000", "internal"],
    ["42P01", "internal"],
  ] as const)("maps %s to %s", (code, expected) => {
    expect(mapPostgrestError(pg(code)).code).toBe(expected);
  });

  it.each(["do_not_contact", "call_in_progress"] as const)("maps P0001 %s to a 409 conflict with that reason", (reason) => {
    const err = mapPostgrestError(pg("P0001", reason));
    expect(err.code).toBe("conflict");
    expect(err.status).toBe(409);
    expect(err.reason).toBe(reason);
  });

  it("maps P0001 rate_limited to a 429", () => {
    const err = mapPostgrestError(pg("P0001", "rate_limited"));
    expect(err.code).toBe("rate_limited");
    expect(err.status).toBe(429);
    expect(err.reason).toBeUndefined();
  });

  it("maps any other P0001 message to internal", () => {
    expect(mapPostgrestError(pg("P0001", "do_not_contact please")).code).toBe("internal");
  });

  it("never copies database text into the user-facing message", () => {
    const err = mapPostgrestError({
      code: "23505",
      message: 'duplicate key value violates unique constraint "phone_numbers_e164_key"',
      details: "Key (e164)=(+14155550150) already exists.",
      hint: null,
    });
    expect(err.message).not.toMatch(/phone_numbers|4155550150|duplicate/);
    expect(err.cause).toBeDefined();
  });

  it("treats null and missing codes as internal", () => {
    expect(mapPostgrestError(null).code).toBe("internal");
    expect(mapPostgrestError({ message: "no code" }).code).toBe("internal");
  });
});

describe("toActionResult", () => {
  it("returns the AppError code and message", () => {
    expect(toActionResult(new AppError("validation", "Business name is required"))).toEqual({
      ok: false,
      error: { code: "validation", message: "Business name is required" },
    });
  });

  it("maps PostgREST-shaped errors", () => {
    expect(toActionResult(pg("P0002", "lead belongs to someone else"))).toEqual({
      ok: false,
      error: { code: "not_found", message: new AppError("not_found").message },
    });
  });

  it("maps Zod errors to validation", () => {
    const parsed = z.object({ leadId: z.uuid() }).safeParse({ leadId: "nope" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(toActionResult(parsed.error).error.code).toBe("validation");
  });

  it("hides unexpected errors and logs them with phone numbers masked", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = toActionResult(new Error("connect failed while dialing +14155550150"));
    expect(result).toEqual({ ok: false, error: { code: "internal", message: new AppError("internal").message } });
    expect(log).toHaveBeenCalledTimes(1);
    const logged = String(log.mock.calls[0]?.[0]);
    expect(logged).not.toContain("4155550150");
    expect(logged).toContain("0150");
  });

  it("does not log expected errors", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    toActionResult(new AppError("forbidden"));
    expect(log).not.toHaveBeenCalled();
  });

  it.each(["NEXT_REDIRECT;replace;/login;307;", "NEXT_HTTP_ERROR_FALLBACK;404"])(
    "rethrows Next.js control flow (%s)",
    (digest) => {
      const signal = nextSignal(digest);
      expect(isNextControlFlowError(signal)).toBe(true);
      expect(() => toActionResult(signal)).toThrow(signal);
    },
  );

  it("does not treat ordinary errors as control flow", () => {
    expect(isNextControlFlowError(new Error("NEXT_REDIRECT"))).toBe(false);
    expect(isNextControlFlowError({ digest: 42 })).toBe(false);
    expect(isNextControlFlowError(null)).toBe(false);
  });
});

describe("runAction", () => {
  it("wraps a successful result", async () => {
    await expect(runAction(async () => 42)).resolves.toEqual({ ok: true, data: 42 });
  });

  it("turns a thrown error into a failure", async () => {
    await expect(
      runAction(async () => {
        throw new AppError("forbidden");
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("lets redirects through", async () => {
    const signal = nextSignal("NEXT_REDIRECT;push;/dashboard;303;");
    await expect(
      runAction(async () => {
        throw signal;
      }),
    ).rejects.toBe(signal);
  });
});

describe("toHttpResponse", () => {
  it("responds with only the error code and the mapped status", async () => {
    const res = toHttpResponse(pg("P0002", "lead 123 belongs to agent B"));
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: "not_found" });
    expect(body).not.toContain("agent B");
  });

  it("does not leak internal error messages", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = toHttpResponse(new Error("password=hunter2 at db.internal:5432"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
  });

  it("maps RPC conflicts to 409", async () => {
    const res = toHttpResponse(pg("P0001", "call_in_progress"));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "conflict" });
  });

  it("rethrows Next.js control flow", () => {
    const signal = nextSignal("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(() => toHttpResponse(signal)).toThrow(signal);
  });

  it("httpError builds the same shape", async () => {
    const res = httpError("rate_limited");
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
  });
});
