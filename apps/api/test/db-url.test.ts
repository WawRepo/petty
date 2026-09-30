import { describe, expect, it } from "vitest";
import { checkDbUrl } from "../src/db-url.js";

// PETTY-289 (review B3): `openssl rand -base64 32` gives a "/" about half the time, and a "/" in the
// password breaks the postgres:// address that compose builds from it.
describe("checkDbUrl", () => {
  it("accepts an address whose password is letters and digits", () => {
    expect(() => checkDbUrl("API_DATABASE_URL", "postgres://petty_api:0f3a9c77be21@db:5432/petty")).not.toThrow();
  });

  it("names the variable and the fix when the password breaks the address, and never shows the password", () => {
    const password = "ab/Cd+eF9=";
    let message = "";
    try {
      checkDbUrl("API_DATABASE_URL", `postgres://petty_api:${password}@db:5432/petty`);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("API_DATABASE_URL");
    expect(message).toContain("openssl rand -hex 32");
    expect(message).not.toContain(password);
    expect(message).not.toContain("ab/Cd");
  });

  it("leaves other forms to the driver", () => {
    expect(() => checkDbUrl("DATABASE_URL", "/var/run/postgresql petty")).not.toThrow();
  });
});
