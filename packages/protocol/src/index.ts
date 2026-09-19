/**
 * @petty/protocol — request and response shapes shared by the API and the web app.
 * Bytes travel as base64. The server validates every body with these schemas and
 * never looks inside ciphertext.
 */
import { z } from "zod";

export const uuid = z.string().uuid();
export const b64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/).max(4_000_000);
export const Role = z.enum(["write", "read"]);
export type Role = z.infer<typeof Role>;
export const AnyRole = z.enum(["owner", "write", "read"]);
export type AnyRole = z.infer<typeof AnyRole>;

export const HealthResponse = z.object({ ok: z.boolean(), db: z.enum(["up", "down"]) });
export type HealthResponse = z.infer<typeof HealthResponse>;

/** A sealed record as it travels: nonce + ciphertext in base64, plus the plaintext versions. */
export const SealedBody = z.object({
  key_version: z.number().int().min(1),
  schema_version: z.number().int().min(1),
  nonce: b64,
  ciphertext: b64,
});
export type SealedBody = z.infer<typeof SealedBody>;

export const PublicKeys = z.object({ ecdh: b64, ecdsa: b64 });
export const VaultBlob = z.object({
  v: z.literal(1),
  kind: z.enum(["passphrase", "recovery", "passkey"]),
  kdf: z.union([
    z.object({ name: z.literal("argon2id"), m: z.number().int(), t: z.number().int(), p: z.number().int(), salt: b64 }),
    z.object({ name: z.literal("hkdf-sha256"), salt: b64 }),
    z.object({ name: z.literal("prf-hkdf-sha256"), salt: b64 }),
  ]),
  pub: PublicKeys,
  ecdh: z.object({ iv: b64, ct: b64 }),
  ecdsa: z.object({ iv: b64, ct: b64 }),
});
export type VaultBlob = z.infer<typeof VaultBlob>;
/**
 * Passkey unlock (Phase 14, several per account since PETTY-102): the WebAuthn credential id, the PRF
 * input salt, the keys wrapped under the PRF-derived key, a label ("iPhone") and the transports the
 * browser reported (so the unlock prompt can offer the phone / QR path). All public/ciphertext.
 */
export const PasskeyVault = z.object({
  credential_id: b64.pipe(z.string().min(4).max(2048)),
  prf_salt: b64,
  vault: VaultBlob,
  label: z.string().trim().max(60).default(""),
  transports: z.array(z.string().max(32)).max(8).default([]),
});
export type PasskeyVault = z.infer<typeof PasskeyVault>;
export const PasskeyEntry = PasskeyVault.extend({ id: uuid, created_at: z.string() });
export type PasskeyEntry = z.infer<typeof PasskeyEntry>;

export const DrawerKeyWrap = z.object({
  v: z.literal(1),
  drawer_id: uuid,
  key_version: z.number().int().min(1),
  sender_ecdh_pub: b64,
  salt: b64,
  wrapped: b64,
  /** Stamped by the server from the session of whoever stored the wrap. The recipient checks sender_ecdh_pub against its PINNED key for this user. */
  sender_id: uuid.optional(),
});
export type DrawerKeyWrap = z.infer<typeof DrawerKeyWrap>;

// ---------------------------------------------------------------- auth
export const SignupBody = z.object({
  join_token: z.string().min(16).max(128),
  email: z.string().email().max(254),
  password: z.string().min(8).max(1024),
  display_name: z.string().trim().min(1).max(80),
  locale: z.enum(["en", "pl"]).default("en"),
  keys: z.object({ ecdh_pub: b64, ecdsa_pub: b64, sig_key_id: z.string().regex(/^[0-9a-f]{32}$/) }),
  /** Passphrase copy of the keys. Optional since PETTY-102: a passkey may be the only everyday door. */
  vault: VaultBlob.optional(),
  /** First passkey, created during setup. At least one of `vault` / `passkey` is required. */
  passkey: PasskeyVault.optional(),
  recovery_vault: VaultBlob,
});
export const LoginBody = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(1024) });
/** Clerk mode (PETTY-88): the vault for an identity Clerk already verified; email and name come from Clerk. */
export const ProvisionBody = SignupBody.omit({ join_token: true, email: true, password: true }).extend({ display_name: z.string().trim().min(1).max(80).optional() });
/** Public: which identity provider the web app must use. */
// contact_email (PETTY-160): where "Get an invite" writes to; set by the operator, absent in older answers and caches.
export const AuthConfig = z.object({ auth: z.enum(["local", "clerk"]), clerk_publishable_key: z.string().nullable(), contact_email: z.string().nullable().optional() });
export type AuthConfig = z.infer<typeof AuthConfig>;
/**
 * Access tokens (PETTY-164). The client makes the whole token: `petty_pat_<id>.<secret>`.
 * It sends the id (the server stores only its hash) and the sealed bundle; the secret stays
 * with the tool, and the server can never open the bundle.
 */
export const SealedBundle = z.object({ nonce: b64, ciphertext: b64 });
/** PETTY-184 (review NR-4): the account key vouches for a writing token's own signing key. */
export const SignedDelegation = z.object({
  v: z.literal(1),
  user_id: uuid,
  account_sig_key_id: z.string(),
  token_ecdsa_pub: b64,
  token_sig_key_id: z.string().regex(/^[0-9a-f]{32}$/),
  created_at: z.string().datetime(),
  expires_at: z.string().datetime().nullable(),
  sig: b64,
}).strict();
export type SignedDelegation = z.infer<typeof SignedDelegation>;
/** Every delegation a user ever made, so entries signed by a token key can be checked (and revoked ones flagged). */
export const UserDelegations = z.object({ delegations: z.array(z.object({ delegation: SignedDelegation, revoked_at: z.string().nullable() })) });
export type UserDelegations = z.infer<typeof UserDelegations>;
export const AccessTokenCreate = z.object({
  token_id: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  /** The token's own ECDH public key (PETTY-169), so later drawers can be wrapped for it. */
  ecdh_pub: b64.optional(),
  name: z.string().trim().min(1).max(80),
  role: z.enum(["read", "write"]),
  /** null = every drawer this user is a member of */
  scope: z.array(uuid).max(200).nullable(),
  expires_at: z.string().datetime().nullable(),
  bundle: SealedBundle,
  /** PETTY-181: making a token needs the account's signing key, not only a session. */
  proof: z.object({ challenge: b64, signature: b64 }),
  /** PETTY-184: a writing token's own signing key and the account's delegation for it. Required for role "write". */
  signing: z.object({ ecdsa_pub: b64, delegation: SignedDelegation }).optional(),
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
  bundle: SealedBundle,
});
export type AccessTokenSelf = z.infer<typeof AccessTokenSelf>;
/** Wrapped drawer keys for one token: what the tool unwraps with the token's private key. */
export const AccessTokenKey = z.object({ drawer_id: uuid, key_version: z.number().int(), wrap: DrawerKeyWrap });
export const AccessTokenKeysBody = z.object({ keys: z.array(AccessTokenKey).max(500) });
export type AccessTokenKey = z.infer<typeof AccessTokenKey>;

export const UserKeys = z.object({ ecdh_pub: b64, ecdsa_pub: b64, sig_key_id: z.string(), created_at: z.string(), retired_at: z.string().nullable() });
export const Me = z.object({
  id: uuid,
  email: z.string(),
  display_name: z.string(),
  locale: z.string(),
  keys: UserKeys,
  /** The active public keys, also present in every vault blob; here so a passkey-only account has them in one place. */
  pub: PublicKeys,
  vault: VaultBlob.nullable(),
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
export const PatchMeBody = z.object({ locale: z.enum(["en", "pl"]).optional(), display_name: z.string().trim().min(1).max(80).optional() });
export const JoinLinkBody = z.object({ email: z.string().email().max(254).optional() });
export const JoinLinkResponse = z.object({ token: z.string(), expires_at: z.string() });
export const JoinLinkInfo = z.object({ valid: z.boolean(), inviter_name: z.string().nullable(), email: z.string().nullable() });

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

export const SealedRow = SealedBody.extend({ author_id: uuid, updated_at: z.string() });
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
  wrap: DrawerKeyWrap,
  state: z.enum(["pending", "accepted", "declined", "revoked"]),
  created_at: z.string(),
});
export type Invitation = z.infer<typeof Invitation>;

export const Bootstrap = z.object({
  me: Me,
  drawers: z.array(DrawerSummary),
  documents: z.record(uuid, SealedRow),
  wraps: z.array(DrawerKeyWrap),
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
export const PutDocumentResponse = z.object({ version: z.number().int(), last_write_at: z.string(), last_verified_at: z.string().nullable() });
export const DeleteLineBody = z.object({ document: PutDocumentBody });
export const PutPhotoBody = SealedBody;

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
export const RestoreDocumentBody = z.object({ history_id: z.string().regex(/^\d+$/), base_version: z.number().int().min(1) });

export const PostEntryBody = z.object({
  id: uuid,
  line_id: uuid,
  is_checkpoint: z.boolean(),
  reverses_entry_id: uuid.nullable(),
  /** required for a checkpoint: the head seq the client counted against */
  expected_head_seq: z.number().int().min(0).optional(),
  key_version: z.number().int().min(1),
  schema_version: z.number().int().min(1),
  nonce: b64,
  ciphertext: b64,
});
export const PostEntryResponse = z.object({ entry: EntryRow, created: z.boolean() });
export const EntriesPage = z.object({ entries: z.array(EntryRow), has_more: z.boolean() });

// ---------------------------------------------------------------- sharing
export const UserLookup = z.object({ id: uuid, display_name: z.string(), keys: UserKeys.nullable() });
export const InviteBody = z.object({ invitee_id: uuid, role: Role, wrap: DrawerKeyWrap });
export const TransferBody = z.object({ to_user_id: uuid });
export const StartRotationBody = z.object({
  to_version: z.number().int().min(2),
  wraps: z.array(z.object({ user_id: uuid, wrap: DrawerKeyWrap })).min(1),
});
export const RotationBatchBody = z.object({
  to_version: z.number().int().min(2),
  entries: z.array(z.object({ id: uuid, nonce: b64, ciphertext: b64 })).max(500),
  document: SealedBody.optional(),
  photo: SealedBody.optional(),
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
  wraps: z.array(DrawerKeyWrap),
});

/** Per-user encrypted document (key pins, preferences), sealed under a key only the user can derive. */
export const UserDocRow = z.object({ version: z.number().int(), schema_version: z.number().int(), nonce: b64, ciphertext: b64, updated_at: z.string() });
export const PutUserDocBody = z.object({ base_version: z.number().int().min(0), schema_version: z.number().int().min(1), nonce: b64, ciphertext: b64 });

// ---------------------------------------------------------------- vault custody changes
/**
 * Proof of key possession (security review SR-2): the challenge from POST /me/custody-challenge,
 * signed with the account's ECDSA key. Only an unlocked vault can produce it.
 */
export const CustodyProof = z.object({ challenge: b64, signature: b64 });
export type CustodyProof = z.infer<typeof CustodyProof>;
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
