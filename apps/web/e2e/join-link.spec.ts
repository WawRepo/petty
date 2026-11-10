import { expect, makeJoinLink, test } from "./fixtures.js";

// PETTY-457: the join token is a secret. It comes after "#", which a browser never sends, and the page asks
// about the link in a request body. An address would stay in the log of every proxy on the way.
test("the join token never travels in an address", async ({ page }) => {
  const token = await makeJoinLink();
  const asked: string[] = [];
  page.on("request", (r) => { const u = new URL(r.url()); asked.push(u.pathname + u.search); });
  const [lookup] = await Promise.all([
    page.waitForRequest((r) => new URL(r.url()).pathname === "/api/join-links/lookup"),
    page.goto(`/join#${token}`),
  ]);
  expect(lookup.method()).toBe("POST");
  expect(lookup.postDataJSON()).toEqual({ token });
  await expect(page.getByLabel("Your name")).toBeVisible(); // the link was found: the form shows
  expect(asked.length).toBeGreaterThan(1);
  expect(asked.filter((a) => a.includes(token))).toEqual([]);
});
