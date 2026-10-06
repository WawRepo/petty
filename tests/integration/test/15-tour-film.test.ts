import { describe, expect, it } from "vitest";
import { ORIGIN } from "../lib.js";

/**
 * PETTY-329: the landing page's tour film is served by the image itself — no third party sees who
 * watches. A browser plays a video in byte ranges (Safari asks for them first and plays nothing
 * without), so each film must answer a range with 206 and the right type; the posters are plain files.
 */
describe("the tour film, from the image", () => {
  for (const film of ["petty-tour.mp4", "petty-tour-tall.mp4"]) {
    it(`serves ${film} in byte ranges, as video/mp4`, async () => {
      const res = await fetch(`${ORIGIN}/landing/tour/${film}`, { headers: { range: "bytes=0-1023" } });
      expect(res.status).toBe(206);
      expect(res.headers.get("content-type")).toBe("video/mp4");
      expect(res.headers.get("content-range")).toMatch(/^bytes 0-1023\/\d{6,}$/);
      const head = new Uint8Array(await res.arrayBuffer());
      expect(head.byteLength).toBe(1024);
      expect(new TextDecoder().decode(head.subarray(4, 8))).toBe("ftyp"); // an MP4, with its index up front (faststart)
      expect(new TextDecoder("latin1").decode(head)).toContain("moov");
    });
  }

  it("serves both posters", async () => {
    for (const poster of ["poster.webp", "poster-tall.webp"]) {
      const res = await fetch(`${ORIGIN}/landing/tour/${poster}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/webp");
    }
  });
});
