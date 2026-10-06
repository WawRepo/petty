/**
 * Cuts the promo films (PETTY-324) from the footage that apps/web/e2e/promo.spec.ts films and draws.
 *
 *   PROMO=1 PROMO_OUT=<dir> npx playwright test e2e/promo.spec.ts --project dev   (in apps/web)
 *   node scripts/promo-video.ts <dir>
 *
 * Writes <dir>/petty-short.mp4 (about 20 s), <dir>/petty-long.mp4 (about 48 s), the feature tour
 * <dir>/petty-tour.mp4 (about 1:40) and its tall cut for phones <dir>/petty-tour-tall.mp4, and a poster;
 * PROMO_FILM=petty-short cuts only that one. Needs ffmpeg 7 or newer on the PATH.
 *
 * Each film is a list of scenes: a piece of one clip on the phone's screen, a background in the
 * example's colour and the words, laid over each other and cross-faded; the music
 * (scripts/promo-music.ts) is made as long as the film.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Layer { readonly png: string; readonly at?: number }
interface Scene {
  readonly clip: string;
  /** Where the piece starts in the clip: seconds, or a mark the camera set and seconds from it. */
  readonly from: number | readonly [mark: string, offset: number];
  readonly dur: number;
  readonly bg: string;
  readonly layers: readonly Layer[];
}
/** `layers`: the folder of pictures to lay over the clips, its layout.json giving the frame and the screen (default "layers", 1920×1080). */
interface Film { readonly name: string; readonly fade: number; readonly scenes: readonly Scene[]; readonly layers?: string }

const cap = (key: string, short = false): Layer[] => [{ png: `cap-${key}${short ? "-short" : ""}` }];
const AI: Layer[] = [{ png: "ai-head" }, { png: "ai-q", at: 0.9 }, { png: "ai-tool", at: 1.7 }, { png: "ai-a", at: 2.4 }];
const tour = (key: string): Layer[] => [{ png: `cap-t-${key}` }];

const TOUR_SCENES: readonly Scene[] = [
  { clip: "home", from: 0, dur: 4.0, bg: "intro", layers: cap("intro") },
  { clip: "t-core", from: 0.2, dur: 8.3, bg: "t-core", layers: tour("core") },
  { clip: "t-nav", from: 0.2, dur: 6.2, bg: "t-nav", layers: tour("nav") },
  { clip: "t-places", from: 0.2, dur: 6.2, bg: "t-places", layers: tour("places") },
  { clip: "t-drawer", from: 0.1, dur: 5.2, bg: "t-drawer", layers: tour("drawer") },
  { clip: "t-items", from: 0.1, dur: 7.8, bg: "t-items", layers: tour("items") },
  { clip: "t-style", from: 0.1, dur: 5.0, bg: "t-style", layers: tour("style") },
  { clip: "cash", from: 0.3, dur: 6.3, bg: "t-entries", layers: tour("entries") },
  { clip: "accounts", from: 0.2, dur: 6.4, bg: "t-check", layers: tour("check") },
  { clip: "t-tags", from: 0.2, dur: 6.9, bg: "t-tags", layers: tour("tags") },
  { clip: "t-search", from: 0.2, dur: 5.9, bg: "t-search", layers: tour("search") },
  { clip: "t-share", from: 0.2, dur: 6.0, bg: "t-share", layers: tour("share") },
  { clip: "t-accept", from: 0, dur: 5.4, bg: "t-accept", layers: tour("accept") },
  { clip: "t-unlock", from: 0.2, dur: 5.0, bg: "t-private", layers: tour("private") },
  { clip: "t-settings", from: 0.2, dur: 5.4, bg: "t-settings", layers: tour("settings") },
  { clip: "t-backup", from: 0.3, dur: 6.3, bg: "t-backup", layers: tour("backup") },
  { clip: "ai", from: 0, dur: 5.6, bg: "ai", layers: AI },
  { clip: "places", from: 0.3, dur: 5.0, bg: "outro", layers: cap("outro") },
];

export const FILMS: readonly Film[] = [
  { name: "petty-long", fade: 0.5, scenes: [
    { clip: "home", from: 0, dur: 4.0, bg: "intro", layers: cap("intro") },
    { clip: "workshop", from: 0.2, dur: 5.6, bg: "workshop", layers: cap("workshop") },
    { clip: "trip", from: 0.2, dur: 6.0, bg: "trip", layers: cap("trip") },
    { clip: "accounts", from: 0.2, dur: 5.8, bg: "accounts", layers: cap("accounts") },
    { clip: "cash", from: 0.3, dur: 6.0, bg: "cash", layers: cap("cash") },
    { clip: "lent", from: 0.3, dur: 4.6, bg: "lent", layers: cap("lent") },
    { clip: "family", from: 0.3, dur: 5.2, bg: "family", layers: cap("family") },
    { clip: "all", from: 0.3, dur: 5.2, bg: "all", layers: cap("all") },
    { clip: "ai", from: 0, dur: 5.4, bg: "ai", layers: AI },
    { clip: "places", from: 0.3, dur: 4.6, bg: "outro", layers: cap("outro") },
  ] },
  // the feature tour (PETTY-325): a chapter a feature, each the real thing on the phone
  { name: "petty-tour", fade: 0.5, scenes: TOUR_SCENES },
  // the same tour for phones (PETTY-329): the words above the phone, 1080×1920
  { name: "petty-tour-tall", fade: 0.5, scenes: TOUR_SCENES, layers: "layers-tall" },
  { name: "petty-short", fade: 0.35, scenes: [
    { clip: "home", from: 0, dur: 3.0, bg: "intro", layers: cap("intro", true) },
    { clip: "workshop", from: ["found", -1.0], dur: 2.8, bg: "workshop", layers: cap("workshop", true) },
    { clip: "trip", from: ["drawer", -0.6], dur: 2.7, bg: "trip", layers: cap("trip", true) },
    { clip: "accounts", from: ["sheet", -0.4], dur: 2.8, bg: "accounts", layers: cap("accounts", true) },
    { clip: "cash", from: ["keypad", -0.2], dur: 3.0, bg: "cash", layers: cap("cash", true) },
    { clip: "lent", from: ["drawer", -0.5], dur: 2.5, bg: "lent", layers: cap("lent", true) },
    { clip: "family", from: ["drawer", -0.5], dur: 2.5, bg: "family", layers: cap("family", true) },
    { clip: "all", from: ["all", -2.3], dur: 3.6, bg: "outro", layers: cap("outro", true) },
  ] },
];

const FPS = 30;
/** Seconds into each scene the words appear, how long they take to come and to go, how far they rise. */
const IN = 0.1, FADE_IN = 0.45, FADE_OUT = 0.3, RISE = 16;

function ffmpeg(args: string[]): string {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-y", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffmpeg failed:\n${r.stderr.slice(-3000)}`);
  return r.stderr;
}

interface Footage { readonly t0: number; readonly end: number; readonly frames: readonly { file: string; t: number }[]; readonly marks: Readonly<Record<string, number>> }

/** One clip's frames, each held until the next, as a steady 30-frames-a-second video. */
function encodeClip(dir: string, name: string): Footage {
  const clip = join(dir, "clips", name);
  const f = JSON.parse(readFileSync(join(clip, "frames.json"), "utf8")) as Footage;
  if (!f.frames.length) throw new Error(`clip ${name} has no frames`);
  const lines = ["ffconcat version 1.0"];
  f.frames.forEach((fr, i) => {
    const from = i === 0 ? f.t0 : fr.t, to = f.frames[i + 1]?.t ?? f.end;
    lines.push(`file '${fr.file}'`, `duration ${Math.max(0.001, to - from).toFixed(4)}`);
  });
  lines.push(`file '${f.frames.at(-1)!.file}'`);
  writeFileSync(join(clip, "list.ffconcat"), `${lines.join("\n")}\n`);
  ffmpeg(["-f", "concat", "-safe", "0", "-i", join(clip, "list.ffconcat"), "-vf", `fps=${FPS},format=yuv420p`, "-c:v", "libx264", "-crf", "12", "-preset", "fast", join(dir, "clips", `${name}.mp4`)]);
  return f;
}

/** Frames, not seconds, so the pieces join without drift: each scene's length and the cross-fade's. */
const frames = (secs: number) => Math.round(secs * FPS);
/** The film's length in seconds: its scenes, less the overlap of each cross-fade. */
export const length = (film: Film) => (film.scenes.reduce((s, x) => s + frames(x.dur), 0) - frames(film.fade) * (film.scenes.length - 1)) / FPS;

/** A working copy of a piece: near-lossless, so the final encode is the only one that shows. */
const PIECE = ["-c:v", "libx264", "-crf", "8", "-preset", "fast", "-pix_fmt", "yuv420p", "-r", String(FPS)];

/**
 * One film, in small steps so no step holds more than a scene in memory (one ffmpeg run with every
 * input queued them all, 19 GB): each scene alone — background, its piece of clip on the screen, the
 * phone, its words — then the scenes' middles and the cross-fades between them, joined end to end
 * under the music.
 */
function cut(dir: string, film: Film, footage: ReadonlyMap<string, Footage>): void {
  const layers = join(dir, film.layers ?? "layers");
  const layout = JSON.parse(readFileSync(join(layers, "layout.json"), "utf8")) as { screen: { x: number; y: number; w: number; h: number } };
  const S = layout.screen, X = frames(film.fade), N = film.scenes.length, total = length(film);
  const work = join(dir, "work", film.name);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const png = (name: string, secs: number) => ["-loop", "1", "-framerate", String(FPS), "-t", secs.toFixed(3), "-i", join(layers, `${name}.png`)];

  const lens = film.scenes.map((sc) => frames(sc.dur));
  film.scenes.forEach((sc, i) => {
    const f = footage.get(sc.clip)!;
    const from = typeof sc.from === "number" ? sc.from : (f.marks[sc.from[0]] ?? (() => { throw new Error(`no mark ${sc.from[0]} in ${sc.clip}`); })()) + sc.from[1];
    const D = lens[i]! / FPS, last = i === N - 1;
    // the words are gone just after the next scene starts fading in; the last scene's stay
    const end = last ? D : (lens[i]! - X) / FPS + 0.05;
    const args = ["-ss", Math.max(0, from).toFixed(3), "-i", join(dir, "clips", `${sc.clip}.mp4`), ...png(`bg-${sc.bg}`, D), ...png("phone", D)];
    const graph = [
      `[0:v]setpts=PTS-STARTPTS,scale=${S.w}:${S.h}:flags=lanczos,tpad=stop_mode=clone:stop_duration=${D},trim=end_frame=${lens[i]},setpts=PTS-STARTPTS[s]`,
      `[1:v][s]overlay=${S.x}:${S.y}:shortest=1[a]`,
      `[a][2:v]overlay=0:0:shortest=1[v0]`,
    ];
    sc.layers.forEach((l, k) => {
      // each layer runs from the scene's start, unseen until its moment: nothing waits in a queue
      const at = IN + (l.at ?? 0);
      args.push(...png(l.png, D));
      const out = last ? "" : `,fade=t=out:st=${(end - FADE_OUT).toFixed(3)}:d=${FADE_OUT}:alpha=1`;
      graph.push(`[${k + 3}:v]format=rgba,fade=t=in:st=${at.toFixed(3)}:d=${FADE_IN}:alpha=1${out}[l${k}]`);
      graph.push(`[v${k}][l${k}]overlay=x=0:y='${RISE}*pow(max(0,1-(t-${at.toFixed(3)})/0.7),3)':eval=frame:shortest=1[v${k + 1}]`);
    });
    graph.push(`[v${sc.layers.length}]fps=${FPS},format=yuv420p,setsar=1[out]`);
    ffmpeg([...args, "-filter_complex", graph.join(";"), "-map", "[out]", "-frames:v", String(lens[i]), ...PIECE, join(work, `scene${i}.mp4`)]);
  });

  // the middles, and a cross-fade where each scene meets the next
  const list = ["ffconcat version 1.0"];
  film.scenes.forEach((_, i) => {
    const a = i === 0 ? 0 : X, b = i === N - 1 ? lens[i]! : lens[i]! - X;
    ffmpeg(["-i", join(work, `scene${i}.mp4`), "-vf", `trim=start_frame=${a}:end_frame=${b},setpts=PTS-STARTPTS`, ...PIECE, join(work, `body${i}.mp4`)]);
    list.push(`file 'body${i}.mp4'`);
    if (i === N - 1) return;
    ffmpeg(["-i", join(work, `scene${i}.mp4`), "-i", join(work, `scene${i + 1}.mp4`), "-filter_complex",
      `[0:v]trim=start_frame=${lens[i]! - X},setpts=PTS-STARTPTS[a];[1:v]trim=end_frame=${X},setpts=PTS-STARTPTS[b];[a][b]xfade=transition=fade:duration=${(X / FPS).toFixed(4)}:offset=0,trim=end_frame=${X}[out]`,
      "-map", "[out]", ...PIECE, join(work, `fade${i}.mp4`)]);
    list.push(`file 'fade${i}.mp4'`);
  });
  writeFileSync(join(work, "list.ffconcat"), `${list.join("\n")}\n`);

  // the music, as long as the film, brought to a quiet −18 LUFS (it sits under the pictures)
  const wav = join(work, "music.wav");
  const made = spawnSync(process.execPath, [join(import.meta.dirname, "promo-music.ts"), total.toFixed(3), wav], { encoding: "utf8" });
  if (made.status !== 0) throw new Error(`music failed: ${made.stderr}`);
  const loud = /I:\s+(-?[\d.]+) LUFS/.exec(ffmpeg(["-i", wav, "-af", "ebur128", "-f", "null", "-"]).split("Summary:").at(-1) ?? "");
  if (!loud) throw new Error("could not measure the music's loudness");
  ffmpeg(["-f", "concat", "-safe", "0", "-i", join(work, "list.ffconcat"), "-i", wav, "-map", "0:v", "-map", "1:a",
    "-af", `volume=${(-18 - Number(loud[1])).toFixed(2)}dB`, "-t", total.toFixed(3),
    "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", String(FPS),
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", join(dir, `${film.name}.mp4`)]);
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) { console.error("usage: node scripts/promo-video.ts <footage dir>"); process.exit(2); }
  const footage = new Map<string, Footage>();
  for (const name of new Set(FILMS.flatMap((f) => f.scenes.map((s) => s.clip)))) footage.set(name, encodeClip(dir, name));
  for (const film of FILMS.filter((f) => !process.env["PROMO_FILM"] || f.name === process.env["PROMO_FILM"])) {
    cut(dir, film, footage);
    process.stdout.write(`${film.name}.mp4  ${length(film).toFixed(1)} s\n`);
    // a poster: the long film's first scene, its words in place
    if (film.name === "petty-long") ffmpeg(["-ss", "2.5", "-i", join(dir, "petty-long.mp4"), "-frames:v", "1", "-q:v", "2", join(dir, "petty-poster.jpg")]);
  }
}
