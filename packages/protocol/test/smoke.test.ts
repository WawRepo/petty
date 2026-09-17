import { describe, expect, it } from "vitest";
import { HealthResponse } from "../src/index.js";
describe("@petty/protocol", () => {
  it("parses a health response", () => {
    expect(HealthResponse.parse({ ok: true, db: "up" })).toEqual({ ok: true, db: "up" });
  });
});
