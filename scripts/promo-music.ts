/**
 * The promo films' music (PETTY-324): made here, note by note, so it has no rights holder but us.
 *
 *   node scripts/promo-music.ts <seconds> <out.wav>
 *
 * A calm loop in D major at 84 beats a minute — D, B minor, G, A — a soft pad under a slow electric
 * piano (two-operator FM) playing the chord tones, a sine bass and a quiet shaker, all through one
 * reverb. The piece is as long as asked: it fades in, ends on D and fades out over its last bars.
 * The same seed gives the same piece every run.
 */
import { writeFileSync } from "node:fs";

export const RATE = 48_000;
const BPM = 84;
const BEAT = 60 / BPM;
const BAR = 4 * BEAT;

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
/** One bar per chord: the bass note, the pad's voicing and the piano's five notes. */
const CHORDS = [
  { bass: 38, pad: [54, 57, 61, 64], keys: [62, 66, 69, 73, 76] }, // Dmaj9
  { bass: 35, pad: [54, 57, 62, 64], keys: [59, 62, 66, 69, 74] }, // Bm11
  { bass: 43, pad: [54, 57, 59, 62], keys: [59, 62, 66, 69, 71] }, // Gmaj9
  { bass: 45, pad: [52, 55, 57, 62], keys: [62, 64, 67, 69, 74] }, // A7sus4
] as const;
/** Where the piano plays in a bar (beat, which of the chord's notes), two shapes taken in turn. */
const PATTERNS: readonly (readonly [number, number])[][] = [
  [[0, 0], [0.5, 2], [1, 3], [1.5, 4], [2.5, 3], [3, 2], [3.5, 1]],
  [[0, 1], [1, 3], [1.5, 4], [2, 2], [3, 3], [3.5, 4]],
];

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Freeverb (Jezar's public-domain design): eight combs and four all-passes per side. */
function reverb(inL: Float32Array, inR: Float32Array, room = 0.86, damp = 0.35): [Float32Array, Float32Array] {
  const k = RATE / 44_100;
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
  const passes = [556, 441, 341, 225];
  const side = (input: Float32Array, spread: number) => {
    const out = new Float32Array(input.length);
    const cs = combs.map((d) => ({ buf: new Float32Array(Math.round((d + spread) * k)), i: 0, store: 0 }));
    const ps = passes.map((d) => ({ buf: new Float32Array(Math.round((d + spread) * k)), i: 0 }));
    for (let n = 0; n < input.length; n++) {
      const x = input[n]! * 0.015;
      let y = 0;
      for (const c of cs) {
        const o = c.buf[c.i]!;
        c.store = o * (1 - damp) + c.store * damp;
        c.buf[c.i] = x + c.store * room;
        if (++c.i >= c.buf.length) c.i = 0;
        y += o;
      }
      for (const p of ps) {
        const b = p.buf[p.i]!;
        p.buf[p.i] = y + b * 0.5;
        y = b - y;
        if (++p.i >= p.buf.length) p.i = 0;
      }
      out[n] = y;
    }
    return out;
  };
  return [side(inL, 0), side(inR, 23)];
}

/** The piece, `seconds` long, as left and right samples in −1…1. */
export function music(seconds: number, seed = 324): [Float32Array, Float32Array] {
  const len = Math.round(seconds * RATE);
  const L = new Float32Array(len), R = new Float32Array(len);
  const wetL = new Float32Array(len), wetR = new Float32Array(len);
  const rnd = mulberry32(seed);
  const bars = Math.max(2, Math.ceil(seconds / BAR));
  // the last bar that starts at least two seconds before the end holds the home chord to the end
  const lastBar = Math.max(1, Math.min(bars - 1, Math.floor((seconds - 2) / BAR)));
  const chordAt = (bar: number) => (bar >= lastBar ? CHORDS[0] : CHORDS[bar % CHORDS.length])!;
  const add = (buf: Float32Array, i: number, v: number) => { if (i >= 0 && i < len) buf[i]! += v; };

  // pad: three slightly detuned voices a note, slow in and out, panned left, centre, right
  const padL = new Float32Array(len), padR = new Float32Array(len);
  for (let bar = 0; bar <= lastBar; bar++) {
    const start = bar * BAR, end = bar >= lastBar ? seconds : (bar + 1) * BAR;
    const attack = bar === 0 ? 1.6 : 0.9, release = 1.4;
    for (const note of chordAt(bar).pad) {
      for (const [cents, pan] of [[-6, 0.15], [0, 0.5], [6, 0.85]] as const) {
        const f = hz(note) * 2 ** (cents / 1200), phase = rnd() * Math.PI * 2;
        const i0 = Math.floor(start * RATE), i1 = Math.min(len, Math.ceil((end + release) * RATE));
        for (let i = i0; i < i1; i++) {
          const t = i / RATE, u = t - start;
          const env = Math.min(1, u / attack) * (t > end ? Math.max(0, 1 - (t - end) / release) : 1);
          const w = 2 * Math.PI * f * t + phase;
          const s = (Math.sin(w) + 0.22 * Math.sin(2 * w) + 0.07 * Math.sin(3 * w)) * env * 0.022 * (1 + 0.12 * Math.sin(2 * Math.PI * 0.13 * t + phase));
          padL[i]! += s * (1 - pan); padR[i]! += s * pan;
        }
      }
    }
  }
  // the pad is soft-edged: a gentle low-pass
  for (const buf of [padL, padR]) { let y = 0; const a = 1 - Math.exp(-2 * Math.PI * 1700 / RATE); for (let i = 0; i < len; i++) { y += a * (buf[i]! - y); buf[i] = y; } }
  for (let i = 0; i < len; i++) { L[i]! += padL[i]!; R[i]! += padR[i]!; wetL[i]! += padL[i]! * 0.5; wetR[i]! += padR[i]! * 0.5; }

  // electric piano: FM, the brightness falling away after each touch
  const piano = (t0: number, midi: number, vel: number) => {
    const f = hz(midi), pan = 0.5 + Math.max(-0.3, Math.min(0.3, (midi - 66) / 30));
    const tau = 1.3 * (440 / f) ** 0.3, i0 = Math.floor(t0 * RATE), n = Math.min(len - i0, Math.round(Math.min(4, tau * 5) * RATE));
    for (let k = 0; k < n; k++) {
      const u = k / RATE;
      const env = Math.min(1, u / 0.004) * Math.exp(-u / tau);
      const index = 1.3 * Math.exp(-u / 0.3) + 0.12;
      const s = Math.sin(2 * Math.PI * f * u + index * Math.sin(2 * Math.PI * f * u)) * env * vel * 0.11;
      add(L, i0 + k, s * (1 - pan)); add(R, i0 + k, s * pan);
      add(wetL, i0 + k, s * (1 - pan)); add(wetR, i0 + k, s * pan);
    }
  };
  for (let bar = 0; bar < lastBar; bar++) {
    const c = chordAt(bar), start = bar * BAR;
    // the first bar only touches the chord; the piano walks from the second
    const pattern = bar === 0 ? [[0, 0], [2, 2]] as const : PATTERNS[bar % 2]!;
    for (const [beat, idx] of pattern) piano(start + beat * BEAT + rnd() * 0.012, c.keys[idx]!, 0.55 + rnd() * 0.3);
  }
  // the end: the home chord, rolled up from the bottom, left to ring
  CHORDS[0].keys.forEach((m, k) => piano(lastBar * BAR + k * 0.07, m, 0.6));

  // bass: the root on the bar, a softer touch before the third beat
  const bass = (t0: number, midi: number, vel: number, dur: number) => {
    const f = hz(midi), i0 = Math.floor(t0 * RATE), n = Math.min(len - i0, Math.round((dur + 0.6) * RATE));
    for (let k = 0; k < n; k++) {
      const u = k / RATE;
      const env = Math.min(1, u / 0.02) * (0.45 + 0.55 * Math.exp(-u / 0.5)) * (u > dur ? Math.max(0, 1 - (u - dur) / 0.6) : 1);
      const w = 2 * Math.PI * f * u;
      const s = (Math.sin(w) + 0.25 * Math.sin(2 * w)) * env * vel * 0.11;
      add(L, i0 + k, s); add(R, i0 + k, s);
    }
  };
  for (let bar = 0; bar <= lastBar; bar++) {
    const c = chordAt(bar), start = bar * BAR;
    if (bar >= lastBar) { bass(start, c.bass, 0.9, seconds - start); break; }
    bass(start, c.bass, 0.9, 2.3 * BEAT);
    if (bar > 0) bass(start + 2.5 * BEAT, c.bass, 0.55, 1.3 * BEAT);
  }

  // shaker: high noise on the eighths from the second bar, the off-beats a little louder
  let hp = 0, prev = 0;
  for (let bar = 1; bar < lastBar; bar++) {
    for (let e = 0; e < 8; e++) {
      const i0 = Math.floor((bar * BAR + e * BEAT / 2 + rnd() * 0.008) * RATE), vel = (e % 2 ? 0.032 : 0.018) * (0.8 + rnd() * 0.4);
      for (let k = 0; k < RATE * 0.09; k++) {
        const u = k / RATE, x = rnd() * 2 - 1;
        hp = 0.82 * (hp + x - prev); prev = x;
        const s = hp * vel * Math.min(1, u / 0.006) * Math.exp(-u / 0.035);
        add(L, i0 + k, s * 0.8); add(R, i0 + k, s);
      }
    }
  }

  const [rl, rr] = reverb(wetL, wetR);
  let peak = 0;
  for (let i = 0; i < len; i++) {
    L[i] = Math.tanh(1.1 * (L[i]! + rl[i]! * 0.9)); R[i] = Math.tanh(1.1 * (R[i]! + rr[i]! * 0.9));
    peak = Math.max(peak, Math.abs(L[i]!), Math.abs(R[i]!));
  }
  const fadeIn = 0.25 * RATE, fadeOut = Math.min(2.5, seconds / 4) * RATE, gain = peak > 0 ? 0.89 / peak : 1;
  for (let i = 0; i < len; i++) {
    const g = gain * Math.min(1, i / fadeIn) * Math.min(1, (len - i) / fadeOut);
    L[i]! *= g; R[i]! *= g;
  }
  return [L, R];
}

/** 16-bit stereo PCM WAV. */
export function wav([L, R]: [Float32Array, Float32Array]): Buffer {
  const n = L.length, b = Buffer.alloc(44 + n * 4);
  b.write("RIFF", 0, "ascii"); b.writeUInt32LE(36 + n * 4, 4); b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii"); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(RATE, 24); b.writeUInt32LE(RATE * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii"); b.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i]!)) * 32767), 44 + i * 4);
    b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i]!)) * 32767), 46 + i * 4);
  }
  return b;
}

if (import.meta.main) {
  const [secs, out] = process.argv.slice(2);
  if (!secs || !out || !(Number(secs) > 0)) { console.error("usage: node scripts/promo-music.ts <seconds> <out.wav>"); process.exit(2); }
  writeFileSync(out, wav(music(Number(secs))));
}
