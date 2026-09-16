import { getServerEnv } from "@/server/env";

export interface RegisterDeps {
  /** Injected so tests can observe the abort without ending the test runner. */
  exit: (code: number) => void;
}

/**
 * Ends the process. `process.exit` is looked up indirectly on purpose: written literally, Next's Edge
 * Runtime analyzer flags this module ("A Node.js API is used (process.exit) which is not supported in
 * the Edge Runtime") and reports a compile error for it on every rebuild, even though `register`
 * returns early on every runtime except Node and the call can never be reached elsewhere.
 */
function abortStartup(code: number): void {
  const exit = Reflect.get(process, "exit") as ((code?: number) => never) | undefined;
  exit?.call(process, code);
}

/**
 * Next calls `register()` once when a server instance starts, and it must finish before the server
 * accepts requests, so this is where "an invalid environment fails loudly" becomes true.
 *
 * `src/server/env.ts` is deliberately lazy — importing it never throws, and `getServerEnv()` parses on
 * first use — which keeps build-time imports safe (`next build` never calls this hook) but meant nothing
 * validated at boot. README and `.env.example` both promised that `DIALER_DRIVER=mock` with
 * `NODE_ENV=production` (D24) stops the server; in fact `next start` came up healthy, served pages, and
 * failed later and partially on the dialer routes — the silent degradation D24 exists to prevent.
 *
 * Throwing is not enough on its own: Next reports "an error occurred while loading instrumentation hook"
 * and then keeps the process up, answering every request with a 500. Measured, not assumed. So we exit
 * as well, which is what actually stops a misconfigured deployment from going live. The message names
 * the offending variables and their rules, never their values.
 */
export async function register(deps: Partial<RegisterDeps> = {}): Promise<void> {
  // Next runs register in every runtime; the app (routes, proxy, server actions) is Node-only.
  const runtime = process.env.NEXT_RUNTIME;
  if (runtime !== undefined && runtime !== "nodejs") return;

  try {
    getServerEnv();
  } catch (error) {
    console.error(`[startup] ${error instanceof Error ? error.message : "invalid server environment"}`);
    const exit = deps.exit ?? abortStartup;
    exit(1);
    // Still thrown, so a host that declines to exit (or a test) sees the failure rather than a server
    // that came up as though nothing were wrong.
    throw error;
  }
}
