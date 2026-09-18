// AES-256-GCM for the Google refresh token (docs/DEVIATIONS.md D47). The ciphertext is the only form the
// token takes outside memory; the key never leaves the server environment.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getServerEnv } from "@/server/env";

const VERSION = "v1";
const IV_BYTES = 12;

function keyBytes(key: string | undefined): Buffer {
  const raw = key ?? getServerEnv().GOOGLE_TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new Error("GOOGLE_TOKEN_ENCRYPTION_KEY is not set");
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== 32) throw new Error("GOOGLE_TOKEN_ENCRYPTION_KEY must be 32 bytes, base64 encoded");
  return bytes;
}

export function encryptRefreshToken(plain: string, key?: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(key), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}

export function decryptRefreshToken(payload: string, key?: string): string {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("stored calendar token is not readable");
  const [, iv, tag, body] = parts;
  const decipher = createDecipheriv("aes-256-gcm", keyBytes(key), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("stored calendar token is not readable");
  }
}
