import { describe, expect, it } from "vitest";
import { repoUrl, sourceUrlFor } from "./links.js";

// PETTY-292 (review S4): AGPL section 13 offers the source of the version that runs, not just the repo.
describe("sourceUrlFor", () => {
  const repo = "https://github.com/WawRepo/petty";
  it("points a release at its tag", () => {
    expect(sourceUrlFor("v1.5.7", repo)).toBe(`${repo}/tree/v1.5.7`);
    expect(sourceUrlFor("v1.5.7", `${repo}/`)).toBe(`${repo}/tree/v1.5.7`);
  });
  it("points anything else at the repository", () => {
    expect(sourceUrlFor("dev", repo)).toBe(repo);
    expect(sourceUrlFor(null, repo)).toBe(repo);
    expect(sourceUrlFor("v1.5.7-fork.2", repo)).toBe(repo);
  });
  it("leaves another host's address alone: its paths differ", () => {
    expect(sourceUrlFor("v1.5.7", "https://codeberg.org/someone/petty")).toBe("https://codeberg.org/someone/petty");
  });
});

// PETTY-461: a fork may set VITE_SOURCE_URL the way `git clone` takes it
describe("repoUrl", () => {
  it("drops .git and a trailing slash, and the version link then works", () => {
    expect(repoUrl("https://github.com/you/petty.git")).toBe("https://github.com/you/petty");
    expect(repoUrl(" https://github.com/you/petty/ ")).toBe("https://github.com/you/petty");
    expect(repoUrl("https://github.com/you/petty.git/")).toBe("https://github.com/you/petty");
    expect(sourceUrlFor("v1.5.7", repoUrl("https://github.com/you/petty.git"))).toBe("https://github.com/you/petty/tree/v1.5.7");
  });
  it("keeps a name that only ends like .git inside, and falls back to upstream when empty", () => {
    expect(repoUrl("https://codeberg.org/you/petty.github")).toBe("https://codeberg.org/you/petty.github");
    expect(repoUrl("")).toBe("https://github.com/WawRepo/petty");
    expect(repoUrl(undefined)).toBe("https://github.com/WawRepo/petty");
  });
});
