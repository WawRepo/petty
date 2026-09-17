/**
 * Tiny IndexedDB key-value store. Holds ONLY: non-extractable CryptoKey handles,
 * ciphertext blobs (vault, wraps) and expiry timestamps. Never plaintext content
 * (CLAUDE.md rule 1).
 */
const DB = "petty";
const STORE = "kv";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then((db) => new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    t.oncomplete = () => db.close();
  }));
}
export const idb = {
  get: <T>(key: string) => tx<T | undefined>("readonly", (s) => s.get(key) as IDBRequest<T | undefined>).catch(() => undefined),
  set: (key: string, value: unknown) => tx("readwrite", (s) => s.put(value, key)).then(() => undefined).catch(() => undefined),
  del: (key: string) => tx("readwrite", (s) => s.delete(key)).then(() => undefined).catch(() => undefined),
  clear: () => tx("readwrite", (s) => s.clear()).then(() => undefined).catch(() => undefined),
  keys: () => tx<IDBValidKey[]>("readonly", (s) => s.getAllKeys()).then((k) => k.map(String)).catch(() => [] as string[]),
};
