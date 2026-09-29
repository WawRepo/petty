import { describe, expect, it } from "vitest";
import { MAIL, MAIL_LOCALES, mailLocale } from "../src/lib/mail-text.js";

/** PETTY-249: every email exists in every language the app speaks, and carries its name and link. */
describe("mail texts", () => {
  const sample = (locale: (typeof MAIL_LOCALES)[number]) => {
    const m = MAIL[locale];
    return {
      joinLink: m.joinLink("Ina", "https://p.test/join#TOKEN"),
      invitationWrite: m.invitation("Ina", "write", "https://p.test"),
      invitationRead: m.invitation("Ina", "read", "https://p.test"),
      relinked: m.relinked("https://p.test", "ops@p.test"),
      revoked: m.revoked("Ina"),
      transferOffered: m.transferOffered("Ina", "https://p.test"),
      transferDone: m.transferDone("Ina"),
      passwordReset: m.passwordReset("https://p.test/reset#TOKEN"),
      passwordChanged: m.passwordChanged("ops@p.test"),
      vaultReplaced: m.vaultReplaced("ops@p.test"),
      handedOver: m.handedOver("Ina"),
    };
  };
  const en = sample("en");
  for (const locale of MAIL_LOCALES) {
    it(`${locale}: every mail has a subject and a text, with its names and links`, () => {
      const s = sample(locale);
      for (const [name, m] of Object.entries(s)) {
        expect(m.subject.trim(), `${locale} ${name}`).not.toBe("");
        expect(m.text.trim(), `${locale} ${name}`).not.toBe("");
        if (locale !== "en") expect(m.subject, `${locale} ${name} is still English`).not.toBe(en[name as keyof typeof en].subject);
      }
      for (const name of ["joinLink", "invitationWrite", "invitationRead", "revoked", "transferOffered", "transferDone", "handedOver"] as const) expect(s[name].text).toContain("Ina");
      expect(s.joinLink.text).toContain("https://p.test/join#TOKEN");
      expect(s.passwordReset.text).toContain("https://p.test/reset#TOKEN");
      for (const name of ["invitationWrite", "relinked", "transferOffered"] as const) expect(s[name].text).toContain("https://p.test/");
      expect(s.invitationWrite.text).not.toBe(s.invitationRead.text);
      // PETTY-281: "tell someone" names who, when the instance has a contact address — and says nothing of it when not
      for (const name of ["relinked", "passwordChanged", "vaultReplaced"] as const) expect(s[name].text, `${locale} ${name}`).toContain("ops@p.test");
      const m = MAIL[locale];
      for (const text of [m.relinked("https://p.test", "").text, m.passwordChanged("").text, m.vaultReplaced("").text]) {
        expect(text).not.toContain("undefined");
        expect(text).not.toMatch(/ \n| {2}/); // no dangling sentence where the address would go
      }
    });
  }
  it("an unknown or missing language falls back to English", () => {
    expect(mailLocale("de")).toBe("de");
    expect(mailLocale("xx")).toBe("en");
    expect(mailLocale(null)).toBe("en");
  });
});
