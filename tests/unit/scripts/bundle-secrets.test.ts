import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../../../scripts/check-bundle-secrets";
import { collectSecrets, findBundleSecretLeaks, listClientBundleFiles, scanBuildOutput } from "../../../scripts/lib/bundle-secrets";

const jwt = (payload: Record<string, unknown>): string =>
  [{ alg: "HS256", typ: "JWT" }, payload]
    .map((part) => Buffer.from(JSON.stringify(part), "utf8").toString("base64url"))
    .concat("c2lnbmF0dXJlLXZhbHVl")
    .join(".");

const SERVICE_JWT = jwt({ iss: "supabase-demo", role: "service_role", exp: 1983812996 });
const ANON_JWT = jwt({ iss: "supabase-demo", role: "anon", exp: 1983812996 });

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function buildDir(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "fmq-bundle-"));
  dirs.push(root);
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

describe("collectSecrets", () => {
  it("takes the server-only secrets from the environment and ignores blank or short values", () => {
    const secrets = collectSecrets({
      SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-value",
      TWILIO_AUTH_TOKEN: "   ",
      TWILIO_API_KEY_SECRET: "short",
      TWILIO_ACCOUNT_SID: "ACnotasecret0000000000",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_JWT,
    });
    expect(secrets.map((s) => s.name)).toEqual(["SUPABASE_SERVICE_ROLE_KEY"]);
  });
});

describe("findBundleSecretLeaks", () => {
  const secrets = [
    { name: "SUPABASE_SERVICE_ROLE_KEY", value: "service-role-secret-value" },
    { name: "TWILIO_AUTH_TOKEN", value: "twilio-auth-token-value" },
  ];

  it("finds literal secret values and service_role JWTs, never an anon JWT", () => {
    const leaks = findBundleSecretLeaks(
      [
        { path: "static/chunks/a.js", content: `const k="service-role-secret-value";` },
        { path: "static/chunks/b.js", content: `fetch(u,{headers:{apikey:"${SERVICE_JWT}"}})` },
        { path: "static/chunks/c.js", content: `const anon="${ANON_JWT}"; const t="twilio-auth-token-value"` },
        { path: "static/chunks/d.js", content: `const clean = 1;` },
      ],
      secrets,
    );
    expect(leaks).toEqual([
      { file: "static/chunks/a.js", reason: "SUPABASE_SERVICE_ROLE_KEY" },
      { file: "static/chunks/b.js", reason: "service_role JWT" },
      { file: "static/chunks/c.js", reason: "TWILIO_AUTH_TOKEN" },
    ]);
  });

  it("never includes the secret value in a finding", () => {
    const leaks = findBundleSecretLeaks([{ path: "x.js", content: "service-role-secret-value" }], secrets);
    expect(JSON.stringify(leaks)).not.toContain("service-role-secret-value");
  });
});

describe("scanBuildOutput", () => {
  it("scans .next/static and client reference manifests, not server-only chunks", () => {
    const root = buildDir({
      ".next/static/chunks/app/page.js": "ok",
      ".next/static/css/app.css": "body{}",
      ".next/server/app/page_client-reference-manifest.js": `x="${SERVICE_JWT}"`,
      ".next/server/app/page.js": `const key = "service-role-secret-value";`,
    });
    const files = listClientBundleFiles(path.join(root, ".next")).map((f) => f.split(path.sep).join("/")).sort();
    expect(files).toEqual(["server/app/page_client-reference-manifest.js", "static/chunks/app/page.js", "static/css/app.css"]);

    const result = scanBuildOutput(path.join(root, ".next"), { SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-value" });
    expect(result.scannedFiles).toBe(3);
    expect(result.leaks).toEqual([{ file: "server/app/page_client-reference-manifest.js", reason: "service_role JWT" }]);
  });

  it("throws when there is no build output to scan", () => {
    expect(() => scanBuildOutput(path.join(tmpdir(), "fmq-missing-build-dir"), {})).toThrow(/next build/);
  });
});

// SPEC 12 requires grepping the production build for secrets. The check used to exit 0 whether or not
// it had anything to search for: with an empty environment (a fresh clone, or any shell where the
// Twilio variables were never exported) it printed "(none)" and passed, so CI could record a green
// secret check that never looked for a Twilio secret. A scan that searched for nothing is not a pass.
describe("check:bundle exit codes", () => {
  const CLEAN_BUILD = { ".next/static/chunks/app/page.js": "const ok = 1;" };
  const SECRETS = {
    SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-value",
    TWILIO_AUTH_TOKEN: "twilio-auth-token-value",
    TWILIO_API_KEY_SECRET: "twilio-api-key-secret-value",
  };

  function run(argv: readonly string[], env: Record<string, string | undefined>): { code: number; output: string } {
    const lines: string[] = [];
    const record = (value: unknown) => {
      lines.push(String(value));
    };
    const spies = [
      vi.spyOn(console, "log").mockImplementation(record),
      vi.spyOn(console, "warn").mockImplementation(record),
      vi.spyOn(console, "error").mockImplementation(record),
    ];
    try {
      return { code: main(argv, env as NodeJS.ProcessEnv), output: lines.join("\n") };
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  }

  it("passes when it searched for real secrets and found none", () => {
    const next = path.join(buildDir(CLEAN_BUILD), ".next");
    const { code, output } = run([next], SECRETS);
    expect(code).toBe(0);
    expect(output).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(output).toContain("TWILIO_AUTH_TOKEN");
  });

  it("fails instead of passing vacuously when the environment holds no secrets", () => {
    const next = path.join(buildDir(CLEAN_BUILD), ".next");
    const { code, output } = run([next], {});
    expect(code, "an empty environment must not produce a passing secret check").not.toBe(0);
    expect(output).toMatch(/no secret values set in the environment/);
  });

  it("allows the empty environment only when asked explicitly", () => {
    const next = path.join(buildDir(CLEAN_BUILD), ".next");
    expect(run([next, "--allow-missing-secrets"], {}).code).toBe(0);
    expect(run(["--allow-missing-secrets", next], {}).code).toBe(0);
  });

  it("still reports a leak as 1 and a missing build as 2", () => {
    const leaky = path.join(buildDir({ ".next/static/chunks/app/page.js": `const k="${SECRETS.TWILIO_AUTH_TOKEN}";` }), ".next");
    const leak = run([leaky], SECRETS);
    expect(leak.code).toBe(1);
    expect(leak.output).toContain("TWILIO_AUTH_TOKEN");
    expect(leak.output).not.toContain(SECRETS.TWILIO_AUTH_TOKEN);

    expect(run([path.join(tmpdir(), "fmq-missing-build-dir")], SECRETS).code).toBe(2);
    // A missing build is reported as a missing build even when there are no secrets to search for.
    expect(run([path.join(tmpdir(), "fmq-missing-build-dir")], {}).code).toBe(2);
  });
});
