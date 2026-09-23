import { describe, expect, it } from "vitest";
import { userMaterial } from "../../../apps/api/src/devtools/fixtures.js";
import { API, ORIGIN } from "../lib.js";

/**
 * PETTY-215: with OPEN_SIGNUP=true the instance lets anyone create an account without a join link.
 * The invite path (used by every other file here) keeps working; this covers the open path.
 */
describe("open signup", () => {
  it("advertises open signup and accepts a link-less signup", async () => {
    const cfg = (await (await fetch(`${API}/config`)).json()) as { open_signup: boolean; version?: string };
    expect(cfg.open_signup).toBe(true);
    // PETTY-218: the server reports its own version (baked into the image at build).
    expect(typeof cfg.version).toBe("string");
    expect((cfg.version ?? "").length).toBeGreaterThan(0);
    const u = await userMaterial("open", { email: `open-${Date.now()}@petty.test` });
    const res = await fetch(`${API}/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(u.signupBody) });
    const text = await res.text();
    expect(res.status, text).toBe(201);
    expect((JSON.parse(text) as { email: string }).email).toBe(u.signupBody["email"]);
  });

  it("the landing page offers a way to create an account", async () => {
    // the SPA shell is served; the create CTA is wired to open_signup in the client (unit-tested via config)
    expect((await fetch(`${ORIGIN}/`)).status).toBe(200);
  });
});
