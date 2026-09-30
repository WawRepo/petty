import { describe, expect, it } from "vitest";
import { sourceUrlFor } from "./links.js";

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
