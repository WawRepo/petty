import { describe, expect, it } from "vitest";
import { LedgerError } from "@petty/ledger";
import { crashLabel } from "./crash.js";
import { relativeTime } from "./time.js";

// PETTY-461: a crash names the error's class and code, never its message (rule 2).
describe("crashLabel", () => {
  it("keeps the class and a stable code, drops the message", () => {
    const e = new Error("Groceries jar: 120.50 PLN");
    expect(crashLabel(e)).toBe("Error");
    expect(crashLabel(new TypeError("Cannot read 'Groceries'"))).toBe("TypeError");
    expect(crashLabel(Object.assign(new Error("x"), { code: "DrawerDamaged" }))).toBe("Error (DrawerDamaged)");
    expect(crashLabel(new LedgerError("DuplicateEntry", { line_id: "l1" }))).toBe("LedgerError (DuplicateEntry)");
  });
  it("refuses a name or code that is not a plain word", () => {
    expect(crashLabel(Object.assign(new Error("x"), { name: "Groceries jar 120" }))).toBe("Error");
    expect(crashLabel(Object.assign(new Error("x"), { code: "my cash: 120" }))).toBe("Error");
    expect(crashLabel("a thrown string")).toBe("Error");
    expect(crashLabel(null)).toBe("Error");
  });
});

describe("relativeTime (PETTY-461)", () => {
  const t = ((k: string) => k) as never;
  it("shows a dash for a timestamp that is not a date, instead of throwing", () => {
    expect(relativeTime("not a date", "en", t)).toBe("—");
    expect(relativeTime("", "pl", t)).toBe("—");
  });
  it("still writes real dates", () => {
    const now = Date.parse("2026-11-16T12:00:00Z");
    expect(relativeTime("2026-11-16T11:59:30Z", "en", t, now)).toBe("time.justNow");
    expect(relativeTime("2026-11-16T09:00:00Z", "en", t, now)).toBe("3 hours ago");
    expect(relativeTime("2026-01-02T00:00:00Z", "en", t, now)).toBe("2 Jan 2026");
  });
});
