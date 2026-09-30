import { expect, openSettings, test } from "./fixtures.js";

// PETTY-292 (review S4): the AGPL source offer and the third-party notices, one tap from Settings, for a
// signed-in person too (before, only the landing page linked the notices).
test("Settings → About offers the source and the third-party notices", async ({ alice }) => {
  const { page } = alice;
  await openSettings(page);
  const about = page.getByTestId("about-section");
  await expect(about.getByRole("heading", { name: "About Petty" })).toBeVisible();
  await expect(about).toContainText("GNU Affero General Public License v3");
  await expect(about.getByTestId("app-version")).toHaveText("Petty dev");
  // A dev build is no release, so the link is the repository; a release links its tag (links.test.ts).
  await expect(about.getByTestId("about-source")).toHaveAttribute("href", "https://github.com/WawRepo/petty");
  await expect(about.getByTestId("about-notices")).toHaveAttribute("href", "/THIRD_PARTY_NOTICES.md");
});
