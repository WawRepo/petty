/**
 * @petty/protocol — request and response shapes shared by the API and the web app.
 * Bytes travel as base64. The server validates every body with these schemas and
 * never looks inside ciphertext.
 */
import { z } from "zod";

// PETTY-255: zod 4 builds object parsers with `new Function`; the web app's CSP forbids that and the
// browser reports a Trusted Types violation. The setting is global and must come before any schema
// is built, so it lives here, and the web app takes `z` from this package, never from "zod" itself.
z.config({ jitless: true });
export { z };

export const uuid = z.string().uuid();
const B64_CHARS = /^[A-Za-z0-9+/]*={0,2}$/;
/**
 * Base64 with no size of its own. For what the server ANSWERS with (the `Stored…` shapes and the rows):
 * a value stored before the request sizes below existed keeps its length, and an answer must never fail
 * on one. In a request it is only the `ciphertext` of an entry, a document or a photo, whose limit the
 * route checks, because each has its own and answers 413 with it.
 */
export const b64 = z.string().regex(B64_CHARS).max(4_000_000);
/** How many bytes a base64 string decodes to, the way `Buffer` and `atob` read it. A loop, not a pattern: its time must not depend on what was sent. */
export function b64ByteLength(s: string): number {
  let n = s.length;
  while (n > 0 && s.charCodeAt(n - 1) === 61) n--; // "="
  return Math.floor((n * 3) / 4);
}
/** Base64 of `min` to `max` bytes; one number means exactly that many. */
export const b64Sized = (min: number, max: number = min) =>
  z.string().max(4 * Math.ceil(max / 3)).regex(B64_CHARS).refine((s) => { const n = b64ByteLength(s); return n >= min && n <= max; }, { message: "base64 of the wrong size" });

/**
 * PETTY-442: the size, in bytes, of every base64 field a request may carry. Each one comes from the
 * code that makes the value; the compatibility corpus and the fixtures are checked against them
 * (test/limits.test.ts). Exact where Petty's own code or the algorithm fixes the length; a range where
 * a browser's DER writer or an older client decides it.
 */
export const FIELD_BYTES = {
  /** The AES-GCM nonce of every seal: @petty/crypto seal.ts (NONCE_BYTES), vault.ts (wrapPrivate), pat.ts (sealPatBundle). */
  nonce: [12, 12],
  /** Made as 16 bytes (vault KDF) or 32 (drawer-key wrap, passkey PRF input); @petty/crypto kdf.ts (assertSalt) opens 16 to 64. */
  salt: [16, 64],
  /** SPKI of a P-256 key: 91 bytes from Chromium, Firefox, WebKit and Node (keys.ts). The room is for another DER spelling of the same key. */
  publicKey: [48, 128],
  /** A 32-byte drawer key under AES-KW, which adds 8 (RFC 3394): drawerKey.ts (wrapDrawerKey). */
  wrappedDrawerKey: [40, 40],
  /** PKCS#8 of a P-256 private key under AES-GCM: 138 + 16 = 154 bytes from the same four engines (vault.ts, wrapPrivate). */
  wrappedPrivateKey: [64, 256],
  /** ECDSA P-256 as WebCrypto writes it, r then s: custody.ts, delegation.ts. */
  signature: [64, 64],
  /** The custody challenge: 32 random bytes from the server (POST /me/custody-challenge). */
  challenge: [32, 32],
} as const;
type Fields = Record<keyof typeof FIELD_BYTES, z.ZodString>;
/** What a request may carry. */
const sized: Fields = {
  nonce: b64Sized(...FIELD_BYTES.nonce), salt: b64Sized(...FIELD_BYTES.salt), publicKey: b64Sized(...FIELD_BYTES.publicKey), wrappedDrawerKey: b64Sized(...FIELD_BYTES.wrappedDrawerKey),
  wrappedPrivateKey: b64Sized(...FIELD_BYTES.wrappedPrivateKey), signature: b64Sized(...FIELD_BYTES.signature), challenge: b64Sized(...FIELD_BYTES.challenge),
};
/** What an answer may carry: whatever is stored. */
const stored: Fields = { nonce: b64, salt: b64, publicKey: b64, wrappedDrawerKey: b64, wrappedPrivateKey: b64, signature: b64, challenge: b64 };

/**
 * PETTY-442: sealed records the padding makes at least one bucket long (@petty/crypto padding.ts and
 * identity.ts: 256 bytes for an entry, 16 KiB for a document, plus the 16-byte GCM tag). The quota counts
 * ciphertext bytes, so a row may not be smaller than any client writes it: every stored row then costs storage.
 */
export const ENTRY_MIN_CIPHERTEXT = 256 + 16;
export const DOCUMENT_MIN_CIPHERTEXT = 16 * 1024 + 16;
/** The person's own sealed document (key pins, places, tags): one row per account, at most 16 buckets of 16 KiB. One bucket holds about 30 pinned people. */
export const USER_DOC_MAX_CIPHERTEXT = 16 * 16 * 1024 + 16;
/** A token's sealed key bundle: about 700 bytes plus 125 for each drawer key in it, so 256 KiB holds about 2000 drawers. */
export const TOKEN_BUNDLE_MAX_CIPHERTEXT = 256 * 1024;
/** Per account: live access tokens (not revoked, not expired), and passkeys. */
export const MAX_ACCESS_TOKENS = 50;
export const MAX_PASSKEYS = 20;
export const Role = z.enum(["write", "read"]);
export type Role = z.infer<typeof Role>;
export const AnyRole = z.enum(["owner", "write", "read"]);
export type AnyRole = z.infer<typeof AnyRole>;

/** PETTY-249: the languages the app and its emails speak. */
export const LocaleCode = z.enum(["en", "pl", "de", "es", "fr"]);
export type LocaleCode = z.infer<typeof LocaleCode>;

export const HealthResponse = z.object({ ok: z.boolean(), db: z.enum(["up", "down"]) });
export type HealthResponse = z.infer<typeof HealthResponse>;

/** A sealed record as a request carries it: a 12-byte nonce and the ciphertext in base64, plus the plaintext versions. */
export const SealedBody = z.object({
  key_version: z.number().int().min(1),
  schema_version: z.number().int().min(1),
  nonce: sized.nonce,
  ciphertext: b64,
});
export type SealedBody = z.infer<typeof SealedBody>;

/** Public keys as the server answers them. */
export const PublicKeys = z.object({ ecdh: b64, ecdsa: b64 });
const vaultBlob = (f: Fields) => z.object({
  v: z.literal(1),
  kind: z.enum(["passphrase", "recovery", "passkey"]),
  kdf: z.union([
    z.object({ name: z.literal("argon2id"), m: z.number().int(), t: z.number().int(), p: z.number().int(), salt: f.salt }),
    z.object({ name: z.literal("hkdf-sha256"), salt: f.salt }),
    z.object({ name: z.literal("prf-hkdf-sha256"), salt: f.salt }),
  ]),
  pub: z.object({ ecdh: f.publicKey, ecdsa: f.publicKey }),
  ecdh: z.object({ iv: f.nonce, ct: f.wrappedPrivateKey }),
  ecdsa: z.object({ iv: f.nonce, ct: f.wrappedPrivateKey }),
});
/** A vault copy as a request carries it, every field at its size. */
export const VaultBlob = vaultBlob(sized);
export type VaultBlob = z.infer<typeof VaultBlob>;
/** A vault copy as the server answers it: exactly what is stored. */
export const StoredVaultBlob = vaultBlob(stored);
/**
 * Passkey unlock (Phase 14, several per account since PETTY-102): the WebAuthn credential id, the PRF
 * input salt, the keys wrapped under the PRF-derived key, a label ("iPhone") and the transports the
 * browser reported (so the unlock prompt can offer the phone / QR path). All public/ciphertext.
 */
const passkeyVault = (f: Fields, vault: typeof VaultBlob) => z.object({
  credential_id: b64.pipe(z.string().min(4).max(2048)),
  prf_salt: f.salt,
  vault,
  label: z.string().trim().max(60).default(""),
  transports: z.array(z.string().max(32)).max(8).default([]),
});
export const PasskeyVault = passkeyVault(sized, VaultBlob);
export type PasskeyVault = z.infer<typeof PasskeyVault>;
/** A passkey as the server answers it. */
export const PasskeyEntry = passkeyVault(stored, StoredVaultBlob).extend({ id: uuid, created_at: z.string() });
export type PasskeyEntry = z.infer<typeof PasskeyEntry>;

const drawerKeyWrap = (f: Fields) => z.object({
  v: z.literal(1),
  drawer_id: uuid,
  key_version: z.number().int().min(1),
  sender_ecdh_pub: f.publicKey,
  salt: f.salt,
  wrapped: f.wrappedDrawerKey,
  /** Stamped by the server from the session of whoever stored the wrap. The recipient checks sender_ecdh_pub against its PINNED key for this user. */
  sender_id: uuid.optional(),
});
/** A wrapped drawer key as a request carries it. */
export const DrawerKeyWrap = drawerKeyWrap(sized);
export type DrawerKeyWrap = z.infer<typeof DrawerKeyWrap>;
/** A wrapped drawer key as the server answers it. */
export const StoredDrawerKeyWrap = drawerKeyWrap(stored);

/**
 * Proof of key possession (security review SR-2): the challenge from POST /me/custody-challenge,
 * signed with the account's ECDSA key. Only an unlocked vault can produce it.
 */
export const CustodyProof = z.object({ challenge: sized.challenge, signature: sized.signature });
export type CustodyProof = z.infer<typeof CustodyProof>;

// ---------------------------------------------------------------- display names
/**
 * PETTY-407 (security review #9): a display name travels into other people's mail ("Ann invited you
 * to a drawer"). A new name is one plain line: no control, invisible or direction-changing characters,
 * and nothing a mail program turns into a link (no "://", "www.", "@", or "word.word"; "J. Smith" is
 * fine). Names saved before this stay valid; the server cleans them where they enter a mail.
 */
const NAME_BREAKS = /[\p{Cc}\p{Zl}\p{Zp}\u00AD\u061C\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu;
const NAME_LINKISH = /:\/\/|www[.\u3002\uFF0E\uFF61]|@|[\p{L}\p{N}][.\u3002\uFF0E\uFF61]\p{L}{2,}/iu;
export type DisplayNameProblem = "control" | "link";
export function displayNameProblem(name: string): DisplayNameProblem | null {
  if (name.search(NAME_BREAKS) >= 0) return "control";
  return NAME_LINKISH.test(name) ? "link" : null;
}
/** The name as one clean line of at most 80 characters, or null when nothing plain is left (a link, an address, empty). */
export function mailSafeName(name: string): string | null {
  const line = [...name.replace(NAME_BREAKS, " ").replace(/\s+/gu, " ").trim()].slice(0, 80).join("").trim();
  return line && !NAME_LINKISH.test(line) ? line : null;
}
export const DisplayName = z.string().trim().min(1).max(80).refine((s) => displayNameProblem(s) === null, { message: "DisplayNameInvalid" });

// ---------------------------------------------------------------- auth
export const SignupBody = z.object({
  join_token: z.string().min(16).max(128).optional(),   // absent = open signup (server allows it only when OPEN_SIGNUP=true)
  email: z.string().email().max(254),
  password: z.string().min(8).max(1024),
  display_name: DisplayName,
  locale: LocaleCode.default("en"),
  keys: z.object({ ecdh_pub: sized.publicKey, ecdsa_pub: sized.publicKey, sig_key_id: z.string().regex(/^[0-9a-f]{32}$/) }),
  /** Passphrase copy of the keys. Optional since PETTY-102: a passkey may be the only everyday door. */
  vault: VaultBlob.optional(),
  /** First passkey, created during setup. At least one of `vault` / `passkey` is required. */
  passkey: PasskeyVault.optional(),
  recovery_vault: VaultBlob,
});
export const LoginBody = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(1024) });
/** Clerk mode (PETTY-88): the vault for an identity Clerk already verified; email and name come from Clerk. */
export const ProvisionBody = SignupBody.omit({ join_token: true, email: true, password: true }).extend({ display_name: DisplayName.optional() });
/** Public: which identity provider the web app must use. */
// contact_email (PETTY-160): where "Get an invite" writes to; set by the operator, absent in older answers and caches.
export const AuthConfig = z.object({ auth: z.enum(["local", "clerk"]), clerk_publishable_key: z.string().nullable(), contact_email: z.string().nullable().optional(), open_signup: z.boolean().optional(), version: z.string().optional(),
  /** PETTY-342: which of the operator's own legal texts this deployment has (GET /legal/:doc). */
  legal: z.object({ privacy: z.boolean(), terms: z.boolean() }).optional() });
export const LegalText = z.object({ doc: z.enum(["privacy", "terms"]), lang: z.string(), text: z.string() });
export type LegalText = z.infer<typeof LegalText>;
export type AuthConfig = z.infer<typeof AuthConfig>;
/**
 * Access tokens (PETTY-164). The client makes the whole token: `petty_pat_<id>.<secret>`.
 * It sends the id (the server stores only its hash) and the sealed bundle; the secret stays
 * with the tool, and the server can never open the bundle.
 */
export const SealedBundle = z.object({ nonce: sized.nonce, ciphertext: b64Sized(16, TOKEN_BUNDLE_MAX_CIPHERTEXT) });
/** A bundle as the server answers it. */
export const StoredSealedBundle = z.object({ nonce: b64, ciphertext: b64 });
/** PETTY-184 (review NR-4): the account key vouches for a writing token's own signing key. As the server answers it. */
export const StoredSignedDelegation = z.object({
  v: z.literal(1),
  user_id: uuid,
  account_sig_key_id: z.string(),
  token_ecdsa_pub: b64,
  token_sig_key_id: z.string().regex(/^[0-9a-f]{32}$/),
  created_at: z.string().datetime(),
  expires_at: z.string().datetime().nullable(),
  sig: b64,
}).strict();
/** A delegation as a request carries it: the same statement, every field at its size (a time is 24 characters as the clients write it). */
export const SignedDelegation = StoredSignedDelegation.extend({
  account_sig_key_id: z.string().regex(/^[0-9a-f]{32}$/),
  token_ecdsa_pub: sized.publicKey,
  created_at: z.string().max(40).datetime(),
  expires_at: z.string().max(40).datetime().nullable(),
  sig: sized.signature,
}).strict();
export type SignedDelegation = z.infer<typeof SignedDelegation>;
/** Every delegation a user ever made, so entries signed by a token key can be checked (and revoked ones flagged). */
export const UserDelegations = z.object({ delegations: z.array(z.object({ delegation: StoredSignedDelegation, revoked_at: z.string().nullable() })) });
export type UserDelegations = z.infer<typeof UserDelegations>;
export const AccessTokenCreate = z.object({
  token_id: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  /** The token's own ECDH public key (PETTY-169), so later drawers can be wrapped for it. */
  ecdh_pub: sized.publicKey.optional(),
  name: z.string().trim().min(1).max(80),
  role: z.enum(["read", "write"]),
  /** null = every drawer this user is a member of */
  scope: z.array(uuid).max(200).nullable(),
  expires_at: z.string().datetime().nullable(),
  bundle: SealedBundle,
  /** PETTY-181: making a token needs the account's signing key, not only a session. */
  proof: CustodyProof,
  /** PETTY-184: a writing token's own signing key and the account's delegation for it. Required for role "write". */
  signing: z.object({ ecdsa_pub: sized.publicKey, delegation: SignedDelegation }).optional(),
});
export const AccessToken = z.object({
  id: uuid,
  name: z.string(),
  /** The token's own ECDH public key; absent on tokens made before PETTY-169. */
  ecdh_pub: b64.nullable().optional(),
  role: z.enum(["read", "write"]),
  scope: z.array(uuid).nullable(),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
  expires_at: z.string().nullable(),
});
export type AccessToken = z.infer<typeof AccessToken>;
/** What a tool fetches with its own token: the sealed bundle plus who it belongs to. */
export const AccessTokenSelf = z.object({
  user_id: uuid,
  /** The owner's current ECDH public key: the sender of every wrap this token holds. */
  owner_ecdh_pub: b64.optional(),
  name: z.string(),
  role: z.enum(["read", "write"]),
  scope: z.array(uuid).nullable(),
  bundle: StoredSealedBundle,
});
export type AccessTokenSelf = z.infer<typeof AccessTokenSelf>;
/** Wrapped drawer keys for one token: what the tool unwraps with the token's private key. */
export const AccessTokenKey = z.object({ drawer_id: uuid, key_version: z.number().int().min(1), wrap: DrawerKeyWrap });
export const AccessTokenKeysBody = z.object({ keys: z.array(AccessTokenKey).max(500) });
export type AccessTokenKey = z.infer<typeof AccessTokenKey>;

/**
 * Device login (PETTY-274): `petty auth login` asks, the web app approves, the tool polls. The page
 * seals an ordinary access token to the tool's one-time key; the server relays that blob and cannot
 * open it. The code the person sees is derived from the tool's key and the site's address
 * (@petty/crypto deviceUserCode): 20 letters since PETTY-451.
 */
const DeviceCode = z.string().regex(/^[BCDFGHJKLMNPQRSTVWXZ]{4}(-[BCDFGHJKLMNPQRSTVWXZ]{4}){4}$/);
export const DeviceCodeRequest = z.object({
  /** The tool's one-time ECDH P-256 public key, base64 SPKI. */
  cli_pub: b64.max(200),
  /** What the page shows and the token is named, for example "petty on laptop". */
  client_name: z.string().trim().min(1).max(80),
  role: z.enum(["read", "write"]),
  /** How long the token lasts; null = until revoked. The same choices as Settings → Access tokens. */
  expires_days: z.union([z.literal(30), z.literal(90), z.literal(365)]).nullable(),
  /**
   * The code the tool shows (PETTY-451). The tool makes it; the server keeps it; the page checks it against
   * the key. A tool from before sends none: the route answers that one by name (CommandLineTooOld).
   */
  user_code: DeviceCode.optional(),
});
export type DeviceCodeRequest = z.infer<typeof DeviceCodeRequest>;
export const DeviceCodeResponse = z.object({
  request_id: uuid,
  /** Only the tool knows it: it polls with it. The server keeps its hash. */
  device_code: z.string().min(40).max(64),
  user_code: DeviceCode,
  expires_in: z.number().int(),
  interval: z.number().int(),
});
export type DeviceCodeResponse = z.infer<typeof DeviceCodeResponse>;
/** What the page shows before the person allows or denies. */
export const DeviceRequestView = z.object({
  id: uuid,
  user_code: DeviceCode,
  cli_pub: b64,
  client_name: z.string(),
  role: z.enum(["read", "write"]),
  expires_days: z.number().int().nullable(),
  ip: z.string().nullable(),
  created_at: z.string(),
  expires_at: z.string(),
});
export type DeviceRequestView = z.infer<typeof DeviceRequestView>;
export const SealedDeviceToken = z.object({ v: z.literal(1), eph_pub: b64.max(200), salt: b64.max(100), nonce: b64.max(40), ciphertext: b64.max(2000) });
export const DeviceApproveBody = z.object({ sealed: SealedDeviceToken });
export const DeviceTokenPoll = z.object({ device_code: z.string().min(40).max(64) });
export const DeviceTokenResponse = z.object({ request_id: uuid, sealed: SealedDeviceToken });
export type DeviceTokenResponse = z.infer<typeof DeviceTokenResponse>;

export const UserKeys = z.object({ ecdh_pub: b64, ecdsa_pub: b64, sig_key_id: z.string(), created_at: z.string(), retired_at: z.string().nullable() });
export const Me = z.object({
  id: uuid,
  email: z.string(),
  display_name: z.string(),
  locale: z.string(),
  keys: UserKeys,
  /** The active public keys, also present in every vault blob; here so a passkey-only account has them in one place. */
  pub: PublicKeys,
  vault: StoredVaultBlob.nullable(),
  passkeys: z.array(PasskeyEntry),
  is_admin: z.boolean(),
});
export type Me = z.infer<typeof Me>;
export const ForgotBody = z.object({ email: z.string().email().max(254) });
export const ResetBody = z.object({ token: z.string().min(16).max(128), password: z.string().min(8).max(1024) });
export const AdminUser = z.object({
  id: uuid, email: z.string(), display_name: z.string(), locale: z.string(), created_at: z.string(), is_admin: z.boolean(),
  blocked_at: z.string().nullable(), deleted: z.boolean(), owned: z.number().int(), last_seen_at: z.string().nullable(), has_passkey: z.boolean(),
});
export type AdminUser = z.infer<typeof AdminUser>;
export const AdminUsers = z.object({ users: z.array(AdminUser) });
export const SetAdminBody = z.object({ is_admin: z.boolean() });
export const PatchMeBody = z.object({ locale: LocaleCode.optional(), display_name: DisplayName.optional() });
export const JoinLinkBody = z.object({ email: z.string().email().max(254).optional() });
export const JoinLinkResponse = z.object({ token: z.string(), expires_at: z.string() });
export const JoinLinkInfo = z.object({ valid: z.boolean(), inviter_name: z.string().nullable(), email: z.string().nullable() });
/** PETTY-457: the token goes in the body of POST /join-links/lookup, never in a URL that proxies and logs keep. */
export const JoinLinkLookupBody = z.object({ token: z.string().min(1).max(128) });

// ---------------------------------------------------------------- drawers
export const DrawerSummary = z.object({
  id: uuid,
  owner_id: uuid,
  role: AnyRole,
  version: z.number().int(),
  key_version: z.number().int(),
  last_write_at: z.string(),
  last_verified_at: z.string().nullable(),
  rotation_needed: z.boolean(),
  has_photo: z.boolean(),
});
export type DrawerSummary = z.infer<typeof DrawerSummary>;

export const SealedRow = SealedBody.extend({ nonce: b64, author_id: uuid, updated_at: z.string() });
export type SealedRow = z.infer<typeof SealedRow>;

export const EntryRow = z.object({
  id: uuid,
  drawer_id: uuid,
  line_id: uuid,
  seq: z.number().int(),
  author_id: uuid,
  is_checkpoint: z.boolean(),
  reverses_entry_id: uuid.nullable(),
  key_version: z.number().int(),
  schema_version: z.number().int(),
  nonce: b64,
  ciphertext: b64,
  received_at: z.string(),
});
export type EntryRow = z.infer<typeof EntryRow>;

export const Member = z.object({ user_id: uuid, display_name: z.string(), role: AnyRole, keys: UserKeys.nullable() });
export type Member = z.infer<typeof Member>;

export const Invitation = z.object({
  id: uuid,
  drawer_id: uuid,
  inviter: z.object({ id: uuid, display_name: z.string(), keys: UserKeys.nullable() }),
  invitee_id: uuid,
  role: Role,
  key_version: z.number().int(),
  wrap: StoredDrawerKeyWrap,
  state: z.enum(["pending", "accepted", "declined", "revoked"]),
  created_at: z.string(),
});
export type Invitation = z.infer<typeof Invitation>;

export const Bootstrap = z.object({
  me: Me,
  drawers: z.array(DrawerSummary),
  documents: z.record(uuid, SealedRow),
  wraps: z.array(StoredDrawerKeyWrap),
  members: z.record(uuid, z.array(Member)),
  /** entries since each line's latest Adjust (inclusive), all drawers */
  entries: z.array(EntryRow),
  invitations: z.array(Invitation),
  transfers: z.array(z.object({ drawer_id: uuid, from_user_id: uuid, to_user_id: uuid })),
});
export type Bootstrap = z.infer<typeof Bootstrap>;
/**
 * What a token may load at start (PETTY-182, review NR-2): its drawers only, their documents and
 * entries, and the signing key id. No vault, passkeys, user wraps, members, invitations or transfers.
 */
/** PETTY-191 (review NR-11): what a tool needs to check who signed an entry — every published key and delegation of each author. */
export const EntryAuthor = z.object({ keys: z.array(UserKeys), delegations: UserDelegations.shape.delegations });
export type EntryAuthor = z.infer<typeof EntryAuthor>;
export const TokenBootstrap = z.object({
  user_id: uuid,
  sig_key_id: z.string(),
  drawers: z.array(DrawerSummary),
  documents: z.record(uuid, SealedRow),
  entries: z.array(EntryRow),
  /** Authors of any entry in these drawers, by user id (PETTY-191). */
  authors: z.record(uuid, EntryAuthor).default({}),
});
export type TokenBootstrap = z.infer<typeof TokenBootstrap>;

export const CreateDrawerBody = z.object({
  id: uuid,
  document: SealedBody,
  self_wrap: DrawerKeyWrap,
});
export const PutDocumentBody = SealedBody.extend({
  base_version: z.number().int().min(1),
  /** true when this write appends a verification: the server stamps last_verified_at */
  verification: z.boolean().default(false),
});
export type PutDocumentBody = z.infer<typeof PutDocumentBody>;
export const PutDocumentResponse = z.object({ version: z.number().int(), last_write_at: z.string(), last_verified_at: z.string().nullable() });
/** PETTY-441: deleting a line removes its entries for good, so it needs a custody proof like deleting a drawer. */
export const DeleteLineBody = z.object({ document: PutDocumentBody, proof: CustodyProof });
export const PutPhotoBody = SealedBody;

/**
 * PETTY-243: size limits the server enforces on ciphertext it cannot read. A photo is a JPEG of at
 * most PHOTO_MAX_BYTES (the web client downscales to that); sealing adds a 4-byte length, pads to
 * the 16 KiB photo bucket and appends the 16-byte GCM tag (@petty/crypto seal.ts). An entry's
 * plaintext is a few hundred bytes (256-byte bucket); 16 KiB leaves wide room for a long comment.
 */
export const PHOTO_MAX_BYTES = 300 * 1024;
export const PHOTO_MAX_CIPHERTEXT = Math.ceil((PHOTO_MAX_BYTES + 4) / (16 * 1024)) * 16 * 1024 + 16;
export const ENTRY_MAX_CIPHERTEXT = 16 * 1024 + 16;

/** PETTY-243: ciphertext bytes stored in the drawers you own, and the instance's limit (null = none). */
export const StorageUsage = z.object({ used_bytes: z.number().int().min(0), quota_bytes: z.number().int().min(1).nullable() });
export type StorageUsage = z.infer<typeof StorageUsage>;

/** PETTY-183 (review NR-3): documents replaced in the last 30 days, still sealed. Owner only. */
export const DocumentHistoryItem = z.object({
  id: z.string(),
  version: z.number().int(),
  written_at: z.string(),
  replaced_at: z.string(),
  replaced_by: uuid.nullable(),
  by_token: z.boolean(),
  document: SealedRow,
});
export const DocumentHistory = z.object({ history: z.array(DocumentHistoryItem) });
export type DocumentHistory = z.infer<typeof DocumentHistory>;

export const PostEntryBody = z.object({
  id: uuid,
  line_id: uuid,
  is_checkpoint: z.boolean(),
  reverses_entry_id: uuid.nullable(),
  /** required for a checkpoint: the head seq the client counted against */
  expected_head_seq: z.number().int().min(0).optional(),
  key_version: z.number().int().min(1),
  schema_version: z.number().int().min(1),
  nonce: sized.nonce,
  ciphertext: b64,
});
export const PostEntryResponse = z.object({ entry: EntryRow, created: z.boolean() });
export const EntriesPage = z.object({ entries: z.array(EntryRow), has_more: z.boolean() });

// ---------------------------------------------------------------- sharing
export const UserLookup = z.object({ id: uuid, display_name: z.string(), keys: UserKeys.nullable() });
/** PETTY-408: the address goes in the body of POST /users/lookup, never in a URL that proxies and logs keep. */
export const UserLookupBody = z.object({ email: z.string().email().max(254) });
export const InviteBody = z.object({ invitee_id: uuid, role: Role, wrap: DrawerKeyWrap });
export const TransferBody = z.object({ to_user_id: uuid });
/**
 * PETTY-440: a rotation re-seals every row of a drawer in place, so starting one and every batch need a
 * custody proof. Any write member's app may continue a rotation; each proves its own vault key.
 */
export const StartRotationBody = z.object({
  to_version: z.number().int().min(2),
  wraps: z.array(z.object({ user_id: uuid, wrap: DrawerKeyWrap })).min(1),
  proof: CustodyProof,
});
export const RotationBatchBody = z.object({
  to_version: z.number().int().min(2),
  entries: z.array(z.object({ id: uuid, nonce: sized.nonce, ciphertext: b64 })).max(500),
  document: SealedBody.optional(),
  photo: SealedBody.optional(),
  proof: CustodyProof,
});
export const RotationStatus = z.object({
  drawer_id: uuid,
  key_version: z.number().int(),
  pending_entries: z.number().int(),
  document_pending: z.boolean(),
  photo_pending: z.boolean(),
  completed: z.boolean(),
});
export const ExportResponse = z.object({
  drawer: DrawerSummary,
  document: SealedRow,
  photo: SealedRow.nullable(),
  entries: z.array(EntryRow),
  wraps: z.array(StoredDrawerKeyWrap),
});

/** Per-user encrypted document (key pins, preferences), sealed under a key only the user can derive. */
export const UserDocRow = z.object({ version: z.number().int(), schema_version: z.number().int(), nonce: b64, ciphertext: b64, updated_at: z.string() });
export const PutUserDocBody = z.object({ base_version: z.number().int().min(0), schema_version: z.number().int().min(1), nonce: sized.nonce, ciphertext: b64Sized(0, USER_DOC_MAX_CIPHERTEXT) });

// ---------------------------------------------------------------- vault custody changes
export const CustodyChallenge = z.object({ challenge: b64, expires_at: z.string() });
/** New passphrase (or recovery-code) wrap of the SAME keys. The server checks the public keys did not change, and the proof. */
/** PETTY-200: a new recovery-code copy of the same keys (the passkey or passphrase copies stay). */
export const PutRecoveryVaultBody = z.object({ password: z.string().min(1).max(1024).optional(), proof: CustodyProof, recovery_vault: VaultBlob });
export const PutVaultBody = z.object({ password: z.string().min(1).max(1024).optional(), proof: CustodyProof, vault: VaultBlob, recovery_vault: VaultBlob.optional() });
/** Add a passkey (POST /me/passkeys): the same custody proof as a vault replace, so a stolen session cannot add a door. */
export const AddPasskeyBody = z.object({ password: z.string().min(1).max(1024).optional(), proof: CustodyProof, passkey: PasskeyVault });
export const RemovePasskeyBody = z.object({ password: z.string().min(1).max(1024).optional(), proof: CustodyProof });

// ---------------------------------------------------------------- account deletion
export const DeleteDecision = z.object({ drawer_id: uuid, action: z.enum(["transfer", "delete"]), to_user_id: uuid.optional() });
export const DeleteAccountBody = z.object({ password: z.string().min(1).max(1024).optional(), proof: CustodyProof, decisions: z.array(DeleteDecision).default([]) });
/** PETTY-201 (red-team INFO-1): deleting a drawer needs a custody proof, like the other destructive acts. */
export const DeleteDrawerBody = z.object({ proof: CustodyProof });
/** What the user must decide before the account can go: every owned drawer that has members. */
export const DeletePreview = z.object({
  shared: z.array(z.object({ drawer_id: uuid, members: z.array(z.object({ user_id: uuid, display_name: z.string(), role: Role })) })),
  sole: z.array(uuid),
  memberships: z.array(uuid),
});
export type DeletePreview = z.infer<typeof DeletePreview>;

// ---------------------------------------------------------------- export archive payload (plaintext, inside sealArchive)
/** One entry as exported: the signed payload plus the server's ordering columns. */
export const ExportEntry = z.object({
  seq: z.number().int(),
  received_at: z.string(),
  entry: z.object({
    v: z.literal(1), id: uuid, drawer_id: uuid, line_id: uuid, op: z.enum(["add", "withdraw", "adjust", "reverse"]),
    amount: z.number().int(), exponent: z.number().int(), comment: z.string(), logged_at: z.string(),
    reverses: uuid.nullable(), prev_hash: z.string().nullable(), delta_hint: z.number().int().nullable(),
    author_id: uuid, sig_key_id: z.string(), sig: z.string(),
  }),
});
export const ExportDrawer = z.object({
  id: uuid,
  document: z.unknown(),          // DrawerDocument (shape owned by @petty/ledger)
  photo_b64: z.string().nullable(),
  members: z.array(z.object({ id: uuid, display_name: z.string(), role: AnyRole })),
  entries: z.array(ExportEntry),
});
/** The plaintext an export archive seals. Self-describing: format + version + who exported it. */
export const ExportPayload = z.object({
  format: z.literal("petty-export"),
  v: z.literal(1),
  exported_at: z.string(),
  exported_by: z.object({ id: uuid, display_name: z.string() }),
  drawers: z.array(ExportDrawer),
});
export type ExportPayload = z.infer<typeof ExportPayload>;
export type ExportDrawer = z.infer<typeof ExportDrawer>;

export const ApiError = z.object({ code: z.string(), message: z.string(), context: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).optional() });
export type ApiError = z.infer<typeof ApiError>;
