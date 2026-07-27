// Symmetric encryption for the Slack bot/user tokens stored in Postgres
// (Workspace.botTokenEncrypted, AppUser.userTokenEncrypted). The classic app
// stored tokens in plaintext; v2 encrypts at rest so a database dump alone
// can't be replayed against Slack. AES-256-GCM gives us confidentiality plus an
// authentication tag that makes tampering detectable on decrypt.

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit nonce, the standard for GCM
const KEY_BYTES = 32;

export interface TokenCipher {
  encrypt(plaintext: string): string;
  decrypt(payload: string): string;
}

/**
 * Parse a 32-byte key supplied as either hex (64 chars) or base64. Anything that
 * doesn't decode to exactly 32 bytes is a configuration error and throws.
 */
function parseKey(key: string): Buffer {
  let buf: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(key)) {
    buf = Buffer.from(key, "hex");
  } else {
    const b = Buffer.from(key, "base64");
    if (b.length === KEY_BYTES) buf = b;
  }
  if (!buf || buf.length !== KEY_BYTES) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64); got ${buf?.length ?? "invalid"} bytes`,
    );
  }
  return buf;
}

export function createTokenCipher(key: string): TokenCipher {
  const keyBuf = parseKey(key);

  return {
    // Wire format: base64(iv).base64(authTag).base64(ciphertext) — three fields
    // so decrypt can pull the IV and tag back out. Dots aren't in base64's
    // alphabet, so they're an unambiguous separator.
    encrypt(plaintext: string): string {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGO, keyBuf, iv);
      const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(".");
    },

    decrypt(payload: string): string {
      const parts = payload.split(".");
      if (parts.length !== 3) throw new Error("tokenCipher: malformed payload");
      const [ivB64, tagB64, ctB64] = parts;
      const decipher = createDecipheriv(ALGO, keyBuf, Buffer.from(ivB64, "base64"));
      decipher.setAuthTag(Buffer.from(tagB64, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(ctB64, "base64")),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}
