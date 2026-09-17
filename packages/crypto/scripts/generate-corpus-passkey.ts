/**
 * Adds the passkey-vault fixture to corpus v1 (Phase 14). RUN ONCE, like
 * generate-corpus.ts: the file is committed and never regenerated. Uses alice's
 * and bob's test keys from users.json and a fixed, recorded PRF output — the
 * 32 bytes a WebAuthn authenticator would return for the recorded salt.
 */
import { access, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createPasskeyVault, importEcdhPublic, importEcdsaPublic, randomBytes, toB64 } from "../src/index.js";

const DIR = fileURLToPath(new URL("../corpus/v1/", import.meta.url));
const OUT = DIR + "passkey.json";
const subtle = crypto.subtle;

interface CorpusUser { id: string; jwk: { ecdh_private: JsonWebKey; ecdsa_private: JsonWebKey }; pub: { ecdh: string; ecdsa: string } }

async function main() {
  try { await access(OUT); throw new Error("refusing to overwrite corpus file passkey.json"); } catch (e) { if ((e as { code?: string }).code !== "ENOENT") throw e; }
  const users = (JSON.parse(await readFile(DIR + "users.json", "utf8")) as { users: CorpusUser[] }).users;
  const out = [];
  for (const u of users) {
    const keys = {
      ecdh: { privateKey: await subtle.importKey("jwk", u.jwk.ecdh_private, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey", "deriveBits"]), publicKey: await importEcdhPublic(u.pub.ecdh) },
      ecdsa: { privateKey: await subtle.importKey("jwk", u.jwk.ecdsa_private, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]), publicKey: await importEcdsaPublic(u.pub.ecdsa) },
    };
    const prf = randomBytes(32);
    out.push({ id: u.id, credential_id: toB64(randomBytes(16)), prf_salt: toB64(randomBytes(32)), prf_output: toB64(prf), pub: u.pub, vault: await createPasskeyVault(prf, keys) });
  }
  await writeFile(OUT, JSON.stringify({ format: "petty-corpus-passkey", v: 1, users: out }, null, 2));
  process.stdout.write(`corpus v1 passkey fixture written to ${OUT}\n`);
}
main().catch((err: unknown) => { console.error(err); process.exit(1); });
