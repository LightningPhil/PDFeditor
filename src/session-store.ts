import type { EditorPage, Source } from "./pdf";
import type { Paragraph } from "./typography";
export interface SessionSnapshot {
  version: 1;
  id: string;
  updatedAt: number;
  sources: Source[];
  history: EditorPage[][];
  cursor: number;
  activeId: string;
  baseline: EditorPage[];
  drafts: Record<string, Record<string, string>>;
  zoom: number;
  selection?: { pageId: string; runIds: string[] };
  formatDrafts?: Record<string, Paragraph>;
  tool?: string;
}
const database = "PDFeditor-local-work";
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(database, 2);
    request.onupgradeneeded = () => {
      const store = request.result.objectStoreNames.contains("sessions")
        ? request.transaction!.objectStore("sessions")
        : request.result.createObjectStore("sessions", { keyPath: "id" });
      if (!store.indexNames.contains("updatedAt"))
        store.createIndex("updatedAt", "updatedAt");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function transact<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("sessions", mode),
      request = action(tx.objectStore("sessions"));
    let result: T;
    request.onsuccess = () => {
      result = request.result;
    };
    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
    tx.onerror = tx.onabort = () => {
      db.close();
      reject(
        tx.error ?? request.error ?? new Error("Local storage unavailable."),
      );
    };
  });
}
export async function saveSession(snapshot: SessionSnapshot) {
  await transact("readwrite", (store) => store.put(snapshot));
}
export async function loadSession(
  id: string,
): Promise<SessionSnapshot | undefined> {
  return transact("readonly", (store) => store.get(id));
}
export async function latestSession(): Promise<SessionSnapshot | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("sessions", "readonly"),
      request = tx
        .objectStore("sessions")
        .index("updatedAt")
        .openCursor(null, "prev");
    let found: SessionSnapshot | undefined;
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const value = cursor.value as SessionSnapshot;
      if (value.version === 1 && value.history[value.cursor]?.length)
        found = value;
      else cursor.continue();
    };
    tx.oncomplete = () => {
      db.close();
      resolve(found);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}
export async function forgetSession(id: string) {
  await transact("readwrite", (store) => store.delete(id));
}
