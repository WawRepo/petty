import { describe, expect, it } from "vitest";
import { downloadUrl, releaseFor, verifyCommand } from "./downloads.js";

// PETTY-418: the programs a person runs on their own computer come from the GitHub release of the version
// that runs here, where they can be checked; only a build that is no release offers this server's own copy.
describe("releaseFor", () => {
  const repo = "https://github.com/WawRepo/petty";
  it("finds the GitHub release of a release version", () => {
    expect(releaseFor("v1.2.3", repo)).toEqual({ repo: "WawRepo/petty", version: "v1.2.3", url: `${repo}/releases/download/v1.2.3` });
    expect(releaseFor("v1.2.3", `${repo}/`)?.url).toBe(`${repo}/releases/download/v1.2.3`);
  });
  it("finds none for a build that is no release", () => {
    for (const version of ["dev", null, "", "v1.2.3-fork.2", "1.5.33", "v1.5", "main"]) expect(releaseFor(version, repo), String(version)).toBeNull();
  });
  it("finds none when the source is not a GitHub repository", () => {
    for (const base of ["https://codeberg.org/someone/petty", "https://github.com/WawRepo", "https://github.com/WawRepo/petty/tree/main", "http://github.com/WawRepo/petty", "https://github.com.example.org/a/b"]) {
      expect(releaseFor("v1.2.3", base), base).toBeNull();
    }
  });
  it("takes no repository name that could change the command a person pastes", () => {
    for (const base of ["https://github.com/a/b;rm -rf ~", "https://github.com/a/b$(id)", "https://github.com/a/b c", "https://github.com/a/b?x=1", "https://github.com/a/b#x"]) {
      expect(releaseFor("v1.2.3", base), base).toBeNull();
    }
  });
});

describe("downloadUrl", () => {
  const release = releaseFor("v1.2.3", "https://github.com/WawRepo/petty");
  it("is the release's file when this Petty runs a release", () => {
    expect(downloadUrl("petty.mjs", release)).toBe("https://github.com/WawRepo/petty/releases/download/v1.2.3/petty.mjs");
    expect(downloadUrl("petty.mcpb", release, "https://petty.example.com")).toBe("https://github.com/WawRepo/petty/releases/download/v1.2.3/petty.mcpb");
  });
  it("is this Petty's own copy otherwise", () => {
    expect(downloadUrl("petty.mcpb", null)).toBe("/downloads/petty.mcpb");
    expect(downloadUrl("petty.mjs", null, "https://petty.example.com")).toBe("https://petty.example.com/downloads/petty.mjs");
  });
});

describe("verifyCommand", () => {
  it("names the repository, its release workflow and main", () => {
    expect(verifyCommand("~/.local/bin/petty", releaseFor("v1.2.3", "https://github.com/WawRepo/petty")!)).toBe(
      "gh attestation verify ~/.local/bin/petty --repo WawRepo/petty --signer-workflow WawRepo/petty/.github/workflows/release.yml --source-ref refs/heads/main",
    );
  });
});
