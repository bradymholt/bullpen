import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * Everything an export must not carry in the clear, sealed under a passphrase.
 * AES-256-GCM with a scrypt-derived key: authenticated, so a wrong passphrase
 * fails loudly instead of decrypting to garbage. All fields base64.
 */
export type SealedBundle = {
  alg: "aes-256-gcm";
  kdf: "scrypt";
  salt: string;
  iv: string;
  tag: string;
  data: string;
};

export type SecretsBundle = {
  /** Per agent: the real env values and the webhook secret. */
  agents: Record<string, { env: Record<string, string>; webhookSecret: string | null }>;
  /** Per space: secret, stable hook id, env. */
  spaces: Record<string, { secret: string; hookId: string | null; env: Record<string, string> }>;
  global: Record<string, string>;
  /** Shared MCP servers with their headers/env; absent in exports from before it was carried. */
  mcp?: Record<string, Record<string, unknown>>;
};

const KEY_BYTES = 32;
// scrypt cost: interactive-grade — a passphrase is typed once at export and once at import.
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase.normalize("NFKC"), salt, KEY_BYTES, SCRYPT);
}

export function seal(bundle: SecretsBundle, passphrase: string): SealedBundle {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(bundle), "utf8"), cipher.final()]);
  return {
    alg: "aes-256-gcm",
    kdf: "scrypt",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

/** Throws on a wrong passphrase or a tampered file — GCM refuses to open either. */
export function open(sealed: SealedBundle, passphrase: string): SecretsBundle {
  if (sealed.alg !== "aes-256-gcm" || sealed.kdf !== "scrypt") throw new Error("unsupported bundle format");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveKey(passphrase, Buffer.from(sealed.salt, "base64")),
    Buffer.from(sealed.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  let text: string;
  try {
    text = Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("wrong passphrase");
  }
  return JSON.parse(text) as SecretsBundle;
}
