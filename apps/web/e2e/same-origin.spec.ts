import { expect, loginAndUnlock, signupViaApi, test } from "./fixtures.js";

/**
 * PETTY-409: a request that changes something must come from Petty's own pages. The browser resolves
 * every name under .localhost to this machine, so two hosts under one made-up domain stand in for the
 * app and for a page on a sibling host: the same site, but not the same origin.
 */
test("a page on a sibling host cannot act with the session; Petty's own page still can", async ({ browser, baseURL }) => {
  const port = new URL(baseURL!).port;
  const app = `http://app.petty.localhost:${port}`;
  const sibling = `http://other.petty.localhost:${port}`;
  const user = await signupViaApi("alice");
  const context = await browser.newContext({ baseURL: app });
  const page = await context.newPage();
  await loginAndUnlock(page, user);

  // The sibling page asks the browser to end the session: a request with no body, and the cookie travels with it.
  // The page never sees the answer (no CORS, and the API's resource policy), so the test reads the wire through
  // the browser's own protocol: what was really sent, and what the API really answered.
  const other = await context.newPage();
  await other.goto(`${sibling}/`);
  const wire = await context.newCDPSession(other);
  await wire.send("Network.enable");
  const ids = new Map<string, string>(), sent = new Map<string, Record<string, string>>(), answered = new Map<string, number>();
  wire.on("Network.requestWillBeSent", (e) => ids.set(e.request.url, e.requestId));
  wire.on("Network.requestWillBeSentExtraInfo", (e) => sent.set(e.requestId, Object.fromEntries(Object.entries(e.headers).map(([k, v]) => [k.toLowerCase(), v]))));
  wire.on("Network.responseReceivedExtraInfo", (e) => answered.set(e.requestId, e.statusCode));
  const logout = `${app}/api/auth/logout`;
  await other.evaluate((url) => fetch(url, { method: "POST", mode: "no-cors", credentials: "include" }).then(() => undefined, () => undefined), logout);
  await expect.poll(() => answered.get(ids.get(logout) ?? "")).toBe(403);
  const headers = sent.get(ids.get(logout)!)!;
  expect(headers["sec-fetch-site"]).toBe("same-site");
  expect(headers["cookie"] ?? "").toContain("petty_session=");
  expect(await page.evaluate(() => fetch("/api/me").then((r) => r.status))).toBe(200); // still signed in

  // Petty's own page, through the dev server's proxy, is same-origin: a request with no body passes.
  const [own] = await Promise.all([
    page.waitForResponse((r) => r.url() === `${app}/api/me/custody-challenge`),
    page.evaluate(() => fetch("/api/me/custody-challenge", { method: "POST" }).then(() => undefined)),
  ]);
  expect((await own.request().allHeaders())["sec-fetch-site"]).toBe("same-origin");
  expect(own.status()).toBe(200);
  await context.close();
});
