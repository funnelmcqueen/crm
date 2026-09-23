// encryptRefreshToken/decryptRefreshToken (docs/DEVIATIONS.md D47): AES-256-GCM round trip and failure modes.
// Keys below are obvious fakes (32 zero/one bytes, base64) — never a real value.
import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptRefreshToken, encryptRefreshToken } from "@/server/google/crypto";
import { resetEnvCacheForTests } from "@/server/env";

const KEY = Buffer.alloc(32, 0).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 1).toString("base64");
const NOT_32_BYTES_KEY = Buffer.alloc(16, 0).toString("base64");

function thrownBy(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    if (err instanceof Error) return err;
    throw new Error(`expected an Error, got ${String(err)}`);
  }
  throw new Error("expected the call to throw");
}

describe("encryptRefreshToken / decryptRefreshToken", () => {
  it("round-trips an ASCII token", () => {
    const plain = "1//0gFAKE-refresh-token-value-ascii";
    const payload = encryptRefreshToken(plain, KEY);
    expect(decryptRefreshToken(payload, KEY)).toBe(plain);
  });

  it("round-trips a token with non-ASCII characters", () => {
    const plain = "réfresh-tökén-🔑-value";
    const payload = encryptRefreshToken(plain, KEY);
    expect(decryptRefreshToken(payload, KEY)).toBe(plain);
  });

  it("produces a different payload each time (random IV), and both decrypt back", () => {
    const plain = "same-plaintext-refresh-token";
    const first = encryptRefreshToken(plain, KEY);
    const second = encryptRefreshToken(plain, KEY);
    expect(first).not.toBe(second);
    expect(decryptRefreshToken(first, KEY)).toBe(plain);
    expect(decryptRefreshToken(second, KEY)).toBe(plain);
  });

  it("uses the v1.<iv>.<tag>.<ciphertext> shape", () => {
    const payload = encryptRefreshToken("some-token", KEY);
    const parts = payload.split(".");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
  });

  it("throws when decrypting with a different key, without leaking the plaintext or either key", () => {
    const plain = "super-secret-refresh-token-value";
    const payload = encryptRefreshToken(plain, KEY);
    const err = thrownBy(() => decryptRefreshToken(payload, OTHER_KEY));
    expect(err.message).not.toContain(plain);
    expect(err.message).not.toContain(KEY);
    expect(err.message).not.toContain(OTHER_KEY);
  });

  it("throws when a byte in the ciphertext is flipped (GCM authentication)", () => {
    const payload = encryptRefreshToken("authenticated-refresh-token", KEY);
    const [version, iv, tag, body] = payload.split(".");
    const bytes = Buffer.from(body, "base64");
    bytes[0] = bytes[0] ^ 0xff;
    const tampered = [version, iv, tag, bytes.toString("base64")].join(".");
    expect(() => decryptRefreshToken(tampered, KEY)).toThrow("stored calendar token is not readable");
  });

  it("throws on a wrong version prefix", () => {
    const payload = encryptRefreshToken("some-token", KEY);
    const parts = payload.split(".");
    parts[0] = "v2";
    expect(() => decryptRefreshToken(parts.join("."), KEY)).toThrow("stored calendar token is not readable");
  });

  it("throws on too few parts", () => {
    const payload = encryptRefreshToken("some-token", KEY);
    const parts = payload.split(".");
    expect(() => decryptRefreshToken(parts.slice(0, 3).join("."), KEY)).toThrow("stored calendar token is not readable");
  });

  it("throws the same generic message on a wrong-length IV, not Node's raw crypto error", () => {
    // A zero-length IV fails inside createDecipheriv itself (Node raises "Invalid initialization vector"
    // there, before any authentication is attempted) — the case that used to escape the try block.
    const payload = encryptRefreshToken("some-token", KEY);
    const [version, , tag, body] = payload.split(".");
    const emptyIv = Buffer.alloc(0).toString("base64");
    const tampered = [version, emptyIv, tag, body].join(".");
    const err = thrownBy(() => decryptRefreshToken(tampered, KEY));
    expect(err.message).toBe("stored calendar token is not readable");
    expect(err.message).not.toContain(KEY);
  });

  it("throws the same generic message on a wrong-length auth tag, not Node's raw crypto error", () => {
    const payload = encryptRefreshToken("some-token", KEY);
    const [version, iv, , body] = payload.split(".");
    const shortTag = Buffer.alloc(3, 0).toString("base64");
    const tampered = [version, iv, shortTag, body].join(".");
    const err = thrownBy(() => decryptRefreshToken(tampered, KEY));
    expect(err.message).toBe("stored calendar token is not readable");
    expect(err.message).not.toContain(KEY);
  });

  it("throws a clear configuration error when the key is not 32 bytes decoded", () => {
    const err = thrownBy(() => encryptRefreshToken("some-token", NOT_32_BYTES_KEY));
    expect(err.message).toMatch(/32 bytes/);
    expect(err.message).not.toContain(NOT_32_BYTES_KEY);
  });

  describe("default key from the server environment", () => {
    const BASE_ENV = {
      NODE_ENV: "test",
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321/",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-value",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-value",
    };

    afterEach(() => {
      vi.unstubAllEnvs();
      resetEnvCacheForTests();
    });

    it("falls back to GOOGLE_TOKEN_ENCRYPTION_KEY when no key argument is given", () => {
      for (const [key, value] of Object.entries({ ...BASE_ENV, GOOGLE_TOKEN_ENCRYPTION_KEY: KEY })) {
        vi.stubEnv(key, value);
      }
      resetEnvCacheForTests();

      const plain = "env-sourced-refresh-token";
      const payload = encryptRefreshToken(plain);
      expect(decryptRefreshToken(payload)).toBe(plain);
    });

    it("throws when GOOGLE_TOKEN_ENCRYPTION_KEY is not set and no key argument is given", () => {
      for (const [key, value] of Object.entries(BASE_ENV)) vi.stubEnv(key, value);
      resetEnvCacheForTests();

      expect(() => encryptRefreshToken("some-token")).toThrow(/GOOGLE_TOKEN_ENCRYPTION_KEY/);
    });
  });
});
