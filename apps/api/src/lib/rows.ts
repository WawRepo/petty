import type { DrawerSummary, EntryRow, SealedRow, UserKeys } from "@petty/protocol";
import type { z } from "zod";
import { iso, toB64 } from "./bytes.js";
import type { DrawerRow } from "./perm.js";

export function entryRow(r: Record<string, unknown>): EntryRow {
  return {
    id: r["id"] as string,
    drawer_id: r["drawer_id"] as string,
    line_id: r["line_id"] as string,
    seq: Number(r["seq"]),
    author_id: r["author_id"] as string,
    is_checkpoint: r["is_checkpoint"] as boolean,
    reverses_entry_id: (r["reverses_entry_id"] as string | null) ?? null,
    key_version: r["key_version"] as number,
    schema_version: r["schema_version"] as number,
    nonce: toB64(r["nonce"] as Buffer),
    ciphertext: toB64(r["ciphertext"] as Buffer),
    received_at: iso(r["received_at"] as Date)!,
  };
}

export function sealedRow(r: Record<string, unknown>): SealedRow {
  return {
    author_id: r["author_id"] as string,
    key_version: r["key_version"] as number,
    schema_version: r["schema_version"] as number,
    nonce: toB64(r["nonce"] as Buffer),
    ciphertext: toB64(r["ciphertext"] as Buffer),
    updated_at: iso(r["updated_at"] as Date)!,
  };
}

export function drawerSummary(d: DrawerRow, role: DrawerSummary["role"], hasPhoto: boolean): DrawerSummary {
  return {
    id: d.id, owner_id: d.owner_id, role, version: d.version, key_version: d.key_version,
    last_write_at: iso(d.last_write_at)!, last_verified_at: iso(d.last_verified_at), rotation_needed: d.rotation_needed, has_photo: hasPhoto,
  };
}

export function userKeys(r: Record<string, unknown> | undefined): z.infer<typeof UserKeys> | null {
  if (!r || !r["ecdh_pub"]) return null;
  return { ecdh_pub: r["ecdh_pub"] as string, ecdsa_pub: r["ecdsa_pub"] as string, sig_key_id: r["sig_key_id"] as string, created_at: iso(r["created_at"] as Date)!, retired_at: iso((r["retired_at"] as Date | null) ?? null) };
}
