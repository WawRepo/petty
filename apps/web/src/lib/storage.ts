/**
 * PETTY-243: storage limits. The server refuses a photo over the size limit and any write that
 * would pass the drawer owner's storage quota; this turns those refusals into one message key,
 * and reads how much the signed-in person uses.
 */
import type { StorageUsage } from "@petty/protocol";
import { api, ApiError } from "./api.js";
import { getAuth } from "./session.js";

/** The i18n key for a write refused for size or storage, or null for any other error. */
export function storageErrorKey(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  if (e.code === "PhotoTooLarge") return "errors.photoTooLarge";
  if (e.code !== "StorageQuotaExceeded") return null;
  const a = getAuth();
  const me = a.status === "unlocked" ? a.me.id : null;
  // A member's write into a shared drawer counts against the drawer's owner, who must free the space.
  return e.context["owner_id"] === me ? "errors.storageFull" : "errors.ownerStorageFull";
}

export const fetchStorage = (): Promise<StorageUsage> => api<StorageUsage>("GET", "/me/storage");

/** "12.3 MB" in the reader's locale. */
export function formatMegabytes(bytes: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "unit", unit: "megabyte", maximumFractionDigits: 1 }).format(bytes / (1024 * 1024));
}
