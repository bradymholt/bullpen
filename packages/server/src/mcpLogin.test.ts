import { describe, expect, it } from "vitest";
import { parseAuthUrl } from "./mcpLogin.ts";

describe("parseAuthUrl", () => {
  // Captured from `claude mcp login --no-browser`: an OSC 8 hyperlink whose target and
  // text are the same URL, printed back to back with nothing between them.
  const captured =
    'Starting authentication for "datadog-mcp"…\nVisit this URL to authorize:\n  ' +
    "\x1b]8;;https://app.example.com/oauth2/authorize?client_id=abc&redirect_uri=http%3A%2F%2Flocalhost%3A52177%2Fcallback&state=xyz\x1b\\" +
    "https://app.example.com/oauth2/authorize?client_id=abc&redirect_uri=http%3A%2F%2Flocalhost%3A52177%2Fcallback&state=xyz\x1b]8;;\x1b\\\n\nWaiting for authorization… (^C to cancel)\n";

  it("takes one copy of the URL, without the terminal escapes", () => {
    expect(parseAuthUrl(captured)).toBe(
      "https://app.example.com/oauth2/authorize?client_id=abc&redirect_uri=http%3A%2F%2Flocalhost%3A52177%2Fcallback&state=xyz",
    );
  });

  it("is null until a URL has been printed", () => {
    expect(parseAuthUrl('Starting authentication for "x"…\n')).toBeNull();
  });
});
