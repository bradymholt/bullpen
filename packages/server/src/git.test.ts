import { describe, expect, it } from "vitest";
import { parseRepo } from "./git.ts";

describe("parseRepo", () => {
  it("handles the URL shapes git remotes actually come in", () => {
    const expected = { owner: "you", repo: "bullpen" };
    expect(parseRepo("https://github.com/you/bullpen.git")).toEqual(expected);
    expect(parseRepo("https://github.com/you/bullpen")).toEqual(expected);
    expect(parseRepo("git@github.com:you/bullpen.git")).toEqual(expected);
    expect(parseRepo("ssh://git@github.com/you/bullpen.git")).toEqual(expected);
  });

  it("keeps dots and dashes in the repo name", () => {
    expect(parseRepo("git@github.com:you/my.cool-repo.git")).toEqual({
      owner: "you",
      repo: "my.cool-repo",
    });
  });

  it("returns null for remotes that are not GitHub", () => {
    expect(parseRepo("/private/tmp/demo-repo")).toBeNull();
    expect(parseRepo("git@gitlab.com:you/bullpen.git")).toBeNull();
  });
});
