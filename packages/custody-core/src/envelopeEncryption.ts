import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

// Shared envelope-encryption primitive for every feature that custodies a private key
// server-side (Degen's trading wallets, Subscriptions' per-subscription wallets, the x402
// facilitator). One copy so this security-critical code can't drift — callers own their own
// RootKeyProvider wiring (which env var to read) so a compromise of one domain's root key
// doesn't expose another's.

interface AesPayload {
  iv: string;
  authTag: string;
  ciphertext: string;
}

function aesEncrypt(plaintext: Buffer, key: Buffer): AesPayload {
  const iv = randomBytes(12); // 96-bit IV, the GCM standard
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: iv.toString("base64"), authTag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}

function aesDecrypt(payload: AesPayload, key: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, "base64")), decipher.final()]);
}

/** Root-of-trust abstraction for envelope encryption: encrypts/decrypts the per-wallet data
 * encryption key (DEK), never the private key directly. Swapping a domain's KMS-provider env
 * var to a real implementation is the entire migration path to production-grade custody —
 * nothing else needs to change. */
export interface RootKeyProvider {
  encryptDek(dek: Buffer): Promise<string>;
  decryptDek(serialized: string): Promise<Buffer>;
}

/** *** DEV-MODE WARNING ***
 * Reads a raw AES key straight from the given environment variable. Fine for developing and
 * testing a custody feature end to end, but NOT an acceptable root-of-trust for a wallet that
 * ever holds real money: anyone with read access to the server's environment (a misconfigured
 * log line, a process dump, a compromised deploy pipeline) can decrypt every custodied key at
 * once. Before any wallet built on this is funded with real value, the caller's KMS-provider
 * wrapper must point at a real implementation (AWS KMS, GCP KMS, HashiCorp Vault, etc.) instead
 * of this class. Flagged here deliberately rather than silently shipped as if production-ready. */
export class LocalRootKeyProvider implements RootKeyProvider {
  constructor(private readonly envVarName: string) {}

  private key(): Buffer {
    const hex = process.env[this.envVarName];
    if (!hex) throw new Error(`${this.envVarName} is not set — see .env.example. Generate one with \`openssl rand -hex 32\`.`);
    const key = Buffer.from(hex, "hex");
    if (key.length !== 32) throw new Error(`${this.envVarName} must be exactly 32 bytes (64 hex characters)`);
    return key;
  }

  async encryptDek(dek: Buffer): Promise<string> {
    return JSON.stringify(aesEncrypt(dek, this.key()));
  }

  async decryptDek(serialized: string): Promise<Buffer> {
    return aesDecrypt(JSON.parse(serialized) as AesPayload, this.key());
  }
}

const ENVELOPE_VERSION = 1;

export async function encryptPrivateKey(plaintext: string, provider: RootKeyProvider): Promise<string> {
  const dek = randomBytes(32);
  try {
    const key = aesEncrypt(Buffer.from(plaintext, "utf8"), dek);
    const encryptedDek = await provider.encryptDek(dek);
    return JSON.stringify({ v: ENVELOPE_VERSION, encryptedDek, key });
  } finally {
    dek.fill(0);
  }
}

export async function decryptPrivateKey(encryptedPrivateKey: string, provider: RootKeyProvider): Promise<string> {
  const envelope = JSON.parse(encryptedPrivateKey) as { v: number; encryptedDek: string; key: AesPayload };
  if (envelope.v !== ENVELOPE_VERSION) throw new Error(`Unknown envelope version ${envelope.v}`);
  const dek = await provider.decryptDek(envelope.encryptedDek);
  try {
    return aesDecrypt(envelope.key, dek).toString("utf8");
  } finally {
    dek.fill(0);
  }
}
