import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

process.env.BULLPEN_DATA = mkdtempSync(join(tmpdir(), "bullpen-test-"));

const { db } = await import("../db/index.ts");
const { agents, spaceSecrets } = await import("../db/schema.ts");
const { runMigrations } = await import("../db/migrate.ts");
const { api } = await import("./api.ts");

runMigrations();

function patch(name: string, body: unknown) {
  return api.request(`/spaces/${encodeURIComponent(name)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const spaceOf = (id: string) =>
  db.select().from(agents).all().find((a) => a.id === id)?.space ?? null;

beforeEach(() => {
  db.delete(agents).run();
  db.insert(agents).values([
    { id: "a1", name: "dependabot", space: "work" },
    { id: "a2", name: "nightly", space: "work" },
    { id: "a3", name: "personal-bot", space: "home" },
    { id: "a4", name: "loose", space: null },
  ]).run();
});

describe("PATCH /spaces/:name", () => {
  it("carries the space secret to the new name, so the fan-out URL keeps working", async () => {
    db.delete(spaceSecrets).run();
    db.insert(spaceSecrets).values({ space: "work", secret: "s".repeat(32) }).run();
    await patch("work", { name: "linear" });
    const rows = db.select().from(spaceSecrets).all();
    expect(rows.map((r) => r.space)).toEqual(["linear"]);
    expect(rows[0]!.secret).toBe("s".repeat(32));
  });

  it("drops the secret when a space is emptied, since no space is left", async () => {
    db.delete(spaceSecrets).run();
    db.insert(spaceSecrets).values({ space: "work", secret: "s".repeat(32) }).run();
    await patch("work", { name: null });
    expect(db.select().from(spaceSecrets).all()).toEqual([]);
  });

  it("renames every member and leaves other spaces alone", async () => {
    const res = await patch("work", { name: "linear" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ moved: 2, name: "linear" });
    expect(spaceOf("a1")).toBe("linear");
    expect(spaceOf("a2")).toBe("linear");
    expect(spaceOf("a3")).toBe("home");
    expect(spaceOf("a4")).toBeNull();
  });

  it("unassigns every member on a null name", async () => {
    const res = await patch("work", { name: null });
    expect(res.status).toBe(200);
    expect(spaceOf("a1")).toBeNull();
    expect(spaceOf("a2")).toBeNull();
  });

  it("404s on a space nobody is in", async () => {
    expect((await patch("ghost", { name: "x" })).status).toBe(404);
  });

  it("rejects a name that collides case-insensitively with another space", async () => {
    const res = await patch("work", { name: "HOME" });
    expect(res.status).toBe(409);
    expect(spaceOf("a1")).toBe("work");
  });

  it("allows a case-only rename of the space itself", async () => {
    expect((await patch("work", { name: "Work" })).status).toBe(200);
    expect(spaceOf("a1")).toBe("Work");
  });

  it("trims, and rejects a name that is blank or too long", async () => {
    expect((await patch("work", { name: "  linear  " })).status).toBe(200);
    expect(spaceOf("a1")).toBe("linear");
    expect((await patch("linear", { name: "   " })).status).toBe(400);
    expect((await patch("linear", { name: "x".repeat(61) })).status).toBe(400);
  });
});
