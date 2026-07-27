import { createTokenCipher } from "../../src/crypto/tokenCipher";

// A deterministic 32-byte key (hex) for tests. In production this comes from
// TOKEN_ENCRYPTION_KEY and must never be committed.
const KEY_HEX = "0".repeat(64);

describe("tokenCipher", () => {
  const cipher = createTokenCipher(KEY_HEX);

  it("round-trips a token through encrypt/decrypt", () => {
    const token = "xoxb-1234567890-abcdefg";
    const enc = cipher.encrypt(token);
    expect(enc).not.toContain(token); // ciphertext must not leak the plaintext
    expect(cipher.decrypt(enc)).toBe(token);
  });

  it("produces a different ciphertext each call (random IV)", () => {
    const a = cipher.encrypt("same-token");
    const b = cipher.encrypt("same-token");
    expect(a).not.toBe(b);
    expect(cipher.decrypt(a)).toBe("same-token");
    expect(cipher.decrypt(b)).toBe("same-token");
  });

  it("rejects a tampered ciphertext (GCM auth tag)", () => {
    const enc = cipher.encrypt("secret");
    // Flip the last base64 char of the payload to corrupt the auth tag/body.
    const tampered = enc.slice(0, -2) + (enc.endsWith("A=") ? "B=" : "A=");
    expect(() => cipher.decrypt(tampered)).toThrow();
  });

  it("accepts a base64-encoded 32-byte key as well as hex", () => {
    const keyB64 = Buffer.alloc(32, 7).toString("base64");
    const c = createTokenCipher(keyB64);
    expect(c.decrypt(c.encrypt("hello"))).toBe("hello");
  });

  it("throws on a key that is not 32 bytes", () => {
    expect(() => createTokenCipher("tooshort")).toThrow();
  });
});
