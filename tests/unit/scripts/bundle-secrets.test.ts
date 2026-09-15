import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
