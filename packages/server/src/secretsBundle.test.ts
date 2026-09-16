import { describe, expect, it } from "vitest";
import { open, seal, type SecretsBundle } from "./secretsBundle.ts";

// Long, distinctive values: the plaintext-leak check searches the base64 output,
// and a two-letter value like "pw" would match random ciphertext by chance.
const bundle: SecretsBundle = {
  agents: { a1: { env: { GOG_KEYRING_PASSWORD: "keyring-password-plaintext-7f3a" }, webhookSecret: "webhook-secret-plaintext-9c1d" } },
  spaces: { work: { secret: "space-secret-plaintext-4e8b", hookId: "hid", env: { GITHUB_TOKEN: "github-token-plaintext-2a6f" } } },
  global: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-plaintext-5d0c" },
};

describe("secrets bundle", () => {
  it("round-trips under the same passphrase", () => {
    expect(open(seal(bundle, "correct horse"), "correct horse")).toEqual(bundle);
  });

  it("refuses a wrong passphrase rather than returning garbage", () => {
    const sealed = seal(bundle, "correct horse");
    expect(() => open(sealed, "wrong")).toThrow("wrong passphrase");
  });

  it("refuses a tampered file", () => {
    const sealed = seal(bundle, "pw");
    const bytes = Buffer.from(sealed.data, "base64");
    bytes[0] = bytes[0]! ^ 0xff;
    expect(() => open({ ...sealed, data: bytes.toString("base64") }, "pw")).toThrow("wrong passphrase");
  });

  it("never carries the plaintext", () => {
    const sealed = JSON.stringify(seal(bundle, "pw"));
    for (const s of [
      "keyring-password-plaintext-7f3a",
      "webhook-secret-plaintext-9c1d",
      "space-secret-plaintext-4e8b",
      "github-token-plaintext-2a6f",
      "sk-ant-oat01-plaintext-5d0c",
    ]) {
      expect(sealed).not.toContain(s);
    }
  });
});
