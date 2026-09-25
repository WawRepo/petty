/**
 * Reconnect (spec "What happens on reconnect"): send the outbox in order, then
 * reload everything and tell the user what changed while they were away.
 * Replay is idempotent (client ids), so a page killed mid-way just resumes.
 */
import { useSyncExternalStore } from "react";
import { fromB64, fromUtf8, open } from "@petty/crypto";
import type { DocumentOp } from "@petty/ledger";
import { api, ApiError, NetworkError } from "./api.js";
import { getDrawers, loadAll, lineFold, mutateDocument, OpsNoLongerApply, refreshPending } from "./drawers.js";
import { isOnline, onBackOnline } from "./net.js";
import { outboxList, outboxRemove, type OutboxItem } from "./outbox.js";
import { getAuth } from "./session.js";
import { storageErrorKey } from "./storage.js";

export type ReportItem =
  | { kind: "foreign"; drawer_id: string; line_id: string; amount: number; author_id: string; op: string }
  | { kind: "recount"; drawer_id: string; line_id: string }
  | { kind: "reverse_refused"; drawer_id: string; line_id: string; reason: string }
  | { kind: "ops_dropped"; drawer_id: string }
  | { kind: "storage_full"; drawer_id: string; mine: boolean }
  | { kind: "failed"; drawer_id: string };
export interface SyncReport { readonly at: string; readonly items: readonly ReportItem[] }

let report: SyncReport | null = null;
const listeners = new Set<() => void>();
function setReport(r: SyncReport | null): void { report = r; for (const l of listeners) l(); }
export function useSyncReport(): SyncReport | null {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => report);
}
export function dismissReport(): void { setReport(null); }

let running: Promise<void> | null = null;
export function syncOutbox(): Promise<void> {
  if (running) return running;
  running = run().finally(() => { running = null; });
  return running;
}

async function run(): Promise<void> {
  const a = getAuth();
  if (a.status !== "unlocked" || !isOnline()) return;
  const before = getDrawers();
  const known = new Set<string>();
  const localBalances = new Map<string, number>();
  for (const v of before.drawers.values()) {
    for (const [lineId, list] of v.entries) { for (const e of list) known.add(e.entry.id); localBalances.set(`${v.summary.id}/${lineId}`, lineFold(v, lineId).balance); }
  }
  const items = await outboxList(a.me.id);
  const out: ReportItem[] = [];
  for (const item of items) {
    try {
      await send(item);
      await outboxRemove(a.me.id, item.id);
    } catch (e) {
      if (e instanceof NetworkError) return; // still offline: keep the queue
      await outboxRemove(a.me.id, item.id);
      out.push(describeFailure(item, e));
    }
  }
  await refreshPending();
  await loadAll();
  if (items.length || out.length) {
    const after = getDrawers();
    for (const v of after.drawers.values()) {
      for (const [lineId, list] of v.entries) {
        for (const e of list) if (!known.has(e.entry.id) && e.entry.author_id !== a.me.id) out.push({ kind: "foreign", drawer_id: v.summary.id, line_id: lineId, amount: e.entry.amount, author_id: e.entry.author_id, op: e.entry.op });
      }
    }
    if (out.length) setReport({ at: new Date().toISOString(), items: out });
  }
}

async function send(item: OutboxItem): Promise<void> {
  if (item.kind === "entry") { await api("POST", `/drawers/${item.drawer_id}/entries`, item.body); return; }
  const view = getDrawers().drawers.get(item.drawer_id);
  if (!view?.key) { await loadAll(); }
  const v = getDrawers().drawers.get(item.drawer_id);
  if (!v?.key) throw new Error("no key");
  const a = getAuth();
  if (a.status !== "unlocked") throw new Error("locked");
  const bytes = await open(v.key, { record_type: "document", record_id: item.id, drawer_id: item.drawer_id, line_id: null, author_id: a.me.id, key_version: v.summary.key_version, schema_version: 1 }, { nonce: fromB64(item.sealed.nonce), ciphertext: fromB64(item.sealed.ciphertext) });
  const ops = JSON.parse(fromUtf8(bytes)) as DocumentOp[];
  await mutateDocument(item.drawer_id, ops, { verification: item.verification, forceOnline: true });
}

function describeFailure(item: OutboxItem, e: unknown): ReportItem {
  // PETTY-243: refused because the drawer owner's storage is full — say so, not "failed"
  const storage = storageErrorKey(e);
  if (storage === "errors.storageFull" || storage === "errors.ownerStorageFull") return { kind: "storage_full", drawer_id: item.drawer_id, mine: storage === "errors.storageFull" };
  if (item.kind === "entry") {
    if (e instanceof ApiError && e.code === "RecountRequired") return { kind: "recount", drawer_id: item.drawer_id, line_id: item.line_id };
    if (e instanceof ApiError && e.code === "ReverseRefused") return { kind: "reverse_refused", drawer_id: item.drawer_id, line_id: item.line_id, reason: String(e.context["reason"] ?? "refused") };
    return { kind: "failed", drawer_id: item.drawer_id };
  }
  if (e instanceof OpsNoLongerApply) return { kind: "ops_dropped", drawer_id: item.drawer_id };
  return { kind: "failed", drawer_id: item.drawer_id };
}

onBackOnline(() => { void syncOutbox(); });
