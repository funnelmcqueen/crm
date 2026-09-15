import { ZodError } from "zod";

export const APP_ERROR_STATUS = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation: 400,
  conflict: 409,
  rate_limited: 429,
  unavailable: 503,
  internal: 500,
} as const;

export type AppErrorCode = keyof typeof APP_ERROR_STATUS;

/** Machine-readable reason for a `conflict`, raised by RPCs as `P0001` with this exact message. */
export type ConflictReason = "do_not_contact" | "call_in_progress";

const DEFAULT_MESSAGES: Record<AppErrorCode, string> = {
  unauthorized: "Please sign in again.",
  forbidden: "You don't have permission to do that.",
  not_found: "Not found.",
  validation: "Some of the information is invalid.",
  conflict: "That can't be done right now.",
  rate_limited: "Too many requests. Try again in a moment.",
  unavailable: "This feature is not available right now.",
  internal: "Something went wrong. Please try again.",
};

const CONFLICT_MESSAGES: Record<ConflictReason, string> = {
  do_not_contact: "This lead is marked Do Not Contact.",
  call_in_progress: "You already have a call in progress.",
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly reason: ConflictReason | undefined;

  /** `message` is shown to the user, so never put database details or other users' data in it. */
  constructor(code: AppErrorCode, message?: string, options?: { cause?: unknown; reason?: ConflictReason }) {
    super(message ?? DEFAULT_MESSAGES[code], options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.reason = options?.reason;
  }

  get status(): number {
    return APP_ERROR_STATUS[this.code];
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

export type ActionSuccess<T> = { ok: true; data: T };
export type ActionFailure = { ok: false; error: { code: AppErrorCode; message: string } };
export type ActionResult<T> = ActionSuccess<T> | ActionFailure;

export function actionOk<T>(data: T): ActionSuccess<T> {
  return { ok: true, data };
}

export interface PostgrestLikeError {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
}

export function mapPostgrestError(err: PostgrestLikeError | null | undefined): AppError {
  const code = err?.code ?? "";
  const cause = err ?? undefined;
  switch (code) {
    case "P0002":
    case "PGRST116":
      return new AppError("not_found", undefined, { cause });
    case "42501":
      return new AppError("forbidden", undefined, { cause });
    case "22023":
    case "22P02":
    case "23514":
    case "23502":
    case "22001":
    case "22007":
    case "22008":
      return new AppError("validation", undefined, { cause });
    case "23505":
    case "23503":
      return new AppError("conflict", undefined, { cause });
    case "PGRST301":
    case "PGRST302":
    case "PGRST303":
      return new AppError("unauthorized", undefined, { cause });
    case "P0001": {
      const message = err?.message ?? "";
      if (message === "do_not_contact" || message === "call_in_progress") {
        return new AppError("conflict", CONFLICT_MESSAGES[message], { cause, reason: message });
      }
      if (message === "rate_limited") {
        return new AppError("rate_limited", undefined, { cause });
      }
      return new AppError("internal", undefined, { cause });
    }
    default:
      return new AppError("internal", undefined, { cause });
  }
}

function isPostgrestLike(err: unknown): err is PostgrestLikeError & { code: string } {
  if (typeof err !== "object" || err === null) return false;
  const candidate = err as Record<string, unknown>;
  return typeof candidate.code === "string" && typeof candidate.message === "string" && "details" in candidate;
}

/**
 * Next.js implements redirect(), notFound() and dynamic bailouts by throwing. They must propagate,
 * so the converters below rethrow them instead of turning them into error results.
 */
export function isNextControlFlowError(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("digest" in err)) return false;
  const digest = (err as { digest: unknown }).digest;
  if (typeof digest !== "string") return false;
  return (
    digest.startsWith("NEXT_REDIRECT") ||
    digest.startsWith("NEXT_HTTP_ERROR_FALLBACK") ||
    digest === "DYNAMIC_SERVER_USAGE" ||
    digest === "BAILOUT_TO_CLIENT_SIDE_RENDERING" ||
    digest === "HANGING_PROMISE_REJECTION" ||
    digest === "NEXT_PRERENDER_INTERRUPTED"
  );
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) {
    return new AppError("validation", err.issues[0]?.message ?? DEFAULT_MESSAGES.validation, { cause: err });
  }
  if (isPostgrestLike(err)) return mapPostgrestError(err);
  return new AppError("internal", undefined, { cause: err });
}

const PHONE_LIKE = /\+?\d[\d\s().-]{5,}\d/g;

function redactForLog(value: string): string {
  return value.replace(PHONE_LIKE, (match) => {
    const digits = match.replace(/\D/g, "");
    return digits.length < 7 ? match : `${match.startsWith("+") ? "+" : ""}${"*".repeat(Math.max(digits.length - 4, 0))}${digits.slice(-4)}`;
  });
}

function logInternal(scope: string, appError: AppError): void {
  if (appError.code !== "internal") return;
  const cause = appError.cause;
  const summary =
    cause instanceof Error
      ? `${cause.name}: ${cause.message}`
      : isPostgrestLike(cause)
        ? `${cause.code}: ${cause.message ?? ""}`
        : String(cause);
  console.error(`[${scope}] internal error: ${redactForLog(summary)}`);
}

/** Converts a caught error into a failed ActionResult. Rethrows Next.js redirect/notFound errors. */
export function toActionResult(err: unknown): ActionFailure {
  if (isNextControlFlowError(err)) throw err;
  const appError = toAppError(err);
  logInternal("action", appError);
  return { ok: false, error: { code: appError.code, message: appError.message } };
}

/** Runs a server action body and never throws to the client (except Next.js control flow). */
export async function runAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return actionOk(await fn());
  } catch (err) {
    return toActionResult(err);
  }
}

export function httpError(code: AppErrorCode): Response {
  return Response.json(
    { error: code },
    { status: APP_ERROR_STATUS[code], headers: { "Cache-Control": "no-store" } },
  );
}

/** JSON `{ error: code }` with the mapped status. Never includes messages or details. */
export function toHttpResponse(err: unknown): Response {
  if (isNextControlFlowError(err)) throw err;
  const appError = toAppError(err);
  logInternal("http", appError);
  return httpError(appError.code);
}
