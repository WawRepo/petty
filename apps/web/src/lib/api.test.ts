import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, setSessionGoneHandler } from "./api.js";

/**
 * A 401 signs the person out, except on the calls that ask for the login password: there it means
 * "wrong password" and the screen says so (PETTY-501: storing a new recovery code was missing).
 */
function answer401() {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ code: "Unauthorized", message: "unauthorized" }), { status: 401 }));
  const gone = vi.fn();
  setSessionGoneHandler(gone);
  return gone;
}
afterEach(() => { vi.unstubAllGlobals(); setSessionGoneHandler(() => undefined); });

describe("a 401 and the session", () => {
  it("a wrong login password when storing a new recovery code keeps the person signed in", async () => {
    const gone = answer401();
    await expect(api("PUT", "/me/recovery-vault", { password: "wrong", recovery_vault: {} })).rejects.toMatchObject({ status: 401, code: "Unauthorized" });
    expect(gone).not.toHaveBeenCalled();
  });

  it("a 401 on reading the recovery copy still means the session is gone", async () => {
    const gone = answer401();
    await expect(api("GET", "/me/recovery-vault")).rejects.toBeInstanceOf(ApiError);
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it("keeps the other password calls as they were, and any other call signs out", async () => {
    const gone = answer401();
    for (const [method, path] of [["PUT", "/me/vault"], ["POST", "/me/passkeys"], ["DELETE", "/me/passkeys/p1"], ["POST", "/me/delete"], ["POST", "/auth/login"]] as const) {
      await expect(api(method, path, {})).rejects.toBeInstanceOf(ApiError);
    }
    expect(gone).not.toHaveBeenCalled();
    await expect(api("GET", "/me")).rejects.toBeInstanceOf(ApiError);
    expect(gone).toHaveBeenCalledTimes(1);
  });
});
