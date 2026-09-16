import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

process.env.BULLPEN_DATA = mkdtempSync(join(tmpdir(), "bullpen-test-"));

const { db } = await import("./db/index.ts");
const { globalConfig, spaceSecrets } = await import("./db/schema.ts");
const { runMigrations } = await import("./db/migrate.ts");
const { MASK, maskEnv, mergeMaskedEnv, resolveEnv, setGlobalEnv } = await import("./env.ts");

runMigrations();

beforeEach(() => {
  db.delete(globalConfig).run();
  db.delete(spaceSecrets).run();
});

describe("env layers", () => {
  it("masks every value and none of the keys", () => {
    expect(maskEnv({ A: "1", B: "two" })).toEqual({ A: MASK, B: MASK });
  });

  it("keeps a stored value when the mask comes back, replaces a typed one, drops an omitted one", () => {
    const merged = mergeMaskedEnv({ KEEP: "old", REPLACE: "old", GONE: "old" }, { KEEP: MASK, REPLACE: "new", " NEW ": "n" });
    expect(merged).toEqual({ KEEP: "old", REPLACE: "new", NEW: "n" });
  });

  it("resolves global, then space, then agent — later wins", () => {
    setGlobalEnv({ TOKEN: "global", ONLY_GLOBAL: "g" });
    db.insert(spaceSecrets).values({ space: "work", secret: "s".repeat(32), env: { TOKEN: "space", ONLY_SPACE: "s" } }).run();
    const env = resolveEnv({ space: "work", env: { TOKEN: "agent" } });
    expect(env).toEqual({ TOKEN: "agent", ONLY_GLOBAL: "g", ONLY_SPACE: "s" });
  });

  it("ignores a space that has no config row", () => {
    setGlobalEnv({ A: "1" });
    expect(resolveEnv({ space: "nowhere", env: {} })).toEqual({ A: "1" });
    expect(resolveEnv({ space: null, env: { B: "2" } })).toEqual({ A: "1", B: "2" });
  });
});

describe("credential precedence", () => {
  it("lets the dashboard's GITHUB_TOKEN win over the process's, matching a run's env", async () => {
    const { githubToken } = await import("./env.ts");
    setGlobalEnv({ GITHUB_TOKEN: "from-dashboard" });
    expect(githubToken()).toBe("from-dashboard");
    setGlobalEnv({});
  });

  it("reports a Claude token held in global env as the credential source", async () => {
    const { claudeCredential } = await import("./env.ts");
    setGlobalEnv({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test" });
    expect(claudeCredential().source).toBe("global-env");
    setGlobalEnv({});
  });
});
