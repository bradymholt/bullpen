import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.BULLPEN_DATA = mkdtempSync(join(tmpdir(), "bullpen-test-"));

const { config } = await import("../config.ts");
const { api } = await import("./api.ts");

beforeAll(() => {
  const dir = join(config.artifactsDir, "run1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "report.html"), "<html><body>the email that went out</body></html>");
  writeFileSync(join(dir, "plan.txt"), "DECISION: wait\n");
  writeFileSync(join(dir, "offers.sqlite"), "not a web type");
});

describe("GET /runs/:id/artifacts/:name", () => {
  it("downloads by default, so a click does not render an agent's markup", async () => {
    const r = await api.request("/runs/run1/artifacts/report.html");
    expect(r.headers.get("content-disposition")).toContain("attachment");
    expect(r.headers.get("content-security-policy")).toBeNull();
    // A download has no origin to abuse, and nosniff here would stop the
    // timeline's <img> rendering a screenshot saved under an extension MIME
    // doesn't know. The headers belong on the preview, not on every byte served.
    expect(r.headers.get("x-content-type-options")).toBeNull();
  });

  it("previews an HTML report with ?inline=1 — that file is usually the email itself", async () => {
    const r = await api.request("/runs/run1/artifacts/report.html?inline=1");
    expect(r.headers.get("content-disposition")).toContain("inline");
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(await r.text()).toContain("the email that went out");
  });

  /**
   * An agent wrote this markup and it renders on the dashboard's own origin.
   * `sandbox` with no allow- tokens gives it an opaque origin and no scripts,
   * so a preview can never reach the API the dashboard is served from.
   */
  it("sandboxes anything it renders, and never sniffs a type", async () => {
    const r = await api.request("/runs/run1/artifacts/report.html?inline=1");
    expect(r.headers.get("content-security-policy")).toBe("sandbox");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("keeps downloading a type no browser should render, even when asked to inline it", async () => {
    const r = await api.request("/runs/run1/artifacts/offers.sqlite?inline=1");
    expect(r.headers.get("content-disposition")).toContain("attachment");
    expect(r.headers.get("content-security-policy")).toBeNull();
  });

  it("still refuses a path that climbs out of the run's directory", async () => {
    expect((await api.request("/runs/run1/artifacts/..%2F..%2Fbullpen.db?inline=1")).status).toBe(404);
  });
});
