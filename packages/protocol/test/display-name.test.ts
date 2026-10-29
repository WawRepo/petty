import { describe, expect, it } from "vitest";
import { DisplayName, PatchMeBody, displayNameProblem, mailSafeName } from "../src/index.js";

/** PETTY-407 (security review #9): a display name travels into other people's mail. */
describe("display names", () => {
  it("takes ordinary names in any script, with emoji, initials and hyphens", () => {
    for (const n of ["Ann", "J. Smith", "Zoë-Łucja Nowak", "Mário d’Ávila", "王小明", "محمد", "Ana 👩‍👩‍👧", "Dr. Who", "A.B.", "O'Brien"]) {
      expect(displayNameProblem(n), n).toBeNull();
      expect(DisplayName.parse(n)).toBe(n);
    }
  });
  it("refuses control, invisible and direction-changing characters", () => {
    for (const n of ["Ann\nVisit us", "Ann\r\nX", "Ann\tB", "Ann B", "Ann‮gnp.exe", "Ann​B", "Ann⁦B", "Ann\u0000"]) expect(displayNameProblem(n), JSON.stringify(n)).toBe("control");
  });
  it("refuses what a mail program would link: schemes, www., addresses, word.word", () => {
    for (const n of ["see https://x.test", "hxxp://x", "www.example", "WWW.EXAMPLE", "ann@example.test", "a@b", "petty-support.com", "Ann from evil.example", "J.Smith", "evil。com", "evil．com"]) expect(displayNameProblem(n), n).toBe("link");
  });
  it("schemas trim and refuse (signup, provision and PATCH /me share it)", () => {
    expect(DisplayName.parse("  Ann  ")).toBe("Ann");
    expect(DisplayName.safeParse("").success).toBe(false);
    expect(DisplayName.safeParse("x".repeat(81)).success).toBe(false);
    expect(PatchMeBody.safeParse({ display_name: "www.example" }).success).toBe(false);
    expect(PatchMeBody.safeParse({ locale: "pl" }).success).toBe(true);
  });
  it("mailSafeName flattens a saved name to one line, or gives up on a link", () => {
    expect(mailSafeName("Ann")).toBe("Ann");
    expect(mailSafeName("  Ann \n\n Smith‮ ")).toBe("Ann Smith");
    expect(mailSafeName("evil​.com")).toBe("evil .com"); // the invisible space no longer hides the dot
    expect(mailSafeName("Ann\nYour account is locked: https://evil.example")).toBeNull();
    expect(mailSafeName("ann@example.test")).toBeNull();
    expect(mailSafeName("\u0000\n\t")).toBeNull();
    expect([...mailSafeName("ż".repeat(200))!]).toHaveLength(80);
  });
});
