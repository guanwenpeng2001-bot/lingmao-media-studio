import type { Graph } from '../api/types';

export interface CanvasDraftKey {
  userId: string;
  workspaceId: string;
  canvasId: string;
  baseRevision: number;
}

export interface CanvasDraftRecord extends CanvasDraftKey {
  key: string;
  name: string;
  graph: Graph;
  savedAt: string;
  reason: 'autosave' | 'offline' | 'conflict' | 'auth_expired';
}

const DB_NAME = 'lingmao_studio_drafts';
const STORE_NAME = 'canvas_drafts';
const DB_VERSION = 1;

// Memory fallback for environments without IndexedDB (e.g. restricted browsers or jsdom)
const memoryStore = new Map<string, CanvasDraftRecord>();

export function buildDraftKey(k: CanvasDraftKey): string {
  return `${k.userId}::${k.workspaceId}::${k.canvasId}::r${k.baseRevision}`;
}

function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveCanvasDraft(
  keyInfo: CanvasDraftKey,
  payload: {
    name: string;
    graph: Graph;
    reason: CanvasDraftRecord['reason'];
  }
): Promise<CanvasDraftRecord> {
  const record: CanvasDraftRecord = {
    ...keyInfo,
    key: buildDraftKey(keyInfo),
    name: payload.name,
    graph: payload.graph,
    reason: payload.reason,
    savedAt: new Date().toISOString(),
  };

  memoryStore.set(record.key, record);
  if (!hasIndexedDb()) {
    return record;
  }
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Keep memoryStore fallback intact
  }
  return record;
}

export async function loadLatestCanvasDraft(params: {
  userId: string;
  workspaceId: string;
  canvasId: string;
}): Promise<CanvasDraftRecord | null> {
  const prefix = `${params.userId}::${params.workspaceId}::${params.canvasId}::`;
  let records: CanvasDraftRecord[] = [];

  if (hasIndexedDb()) {
    try {
      const db = await openDb();
      records = await new Promise<CanvasDraftRecord[]>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).getAll();
        req.onsuccess = () => resolve((req.result as CanvasDraftRecord[]) || []);
        req.onerror = () => reject(req.error);
      });
      db.close();
    } catch {
      records = Array.from(memoryStore.values());
    }
  } else {
    records = Array.from(memoryStore.values());
  }

  const matched = records
    .filter((r) => r.key.startsWith(prefix))
    .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
  return matched[0] ?? null;
}

export async function clearCanvasDrafts(params: {
  userId: string;
  workspaceId: string;
  canvasId: string;
}): Promise<void> {
  const prefix = `${params.userId}::${params.workspaceId}::${params.canvasId}::`;
  for (const k of Array.from(memoryStore.keys())) {
    if (k.startsWith(prefix)) memoryStore.delete(k);
  }
  if (!hasIndexedDb()) return;
  try {
    const db = await openDb();
    const all = await new Promise<CanvasDraftRecord[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve((req.result as CanvasDraftRecord[]) || []);
      req.onerror = () => reject(req.error);
    });
    const toDelete = all.filter((r) => r.key.startsWith(prefix));
    if (toDelete.length > 0) {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        for (const item of toDelete) store.delete(item.key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
    db.close();
  } catch {
    // ignore
  }
}

export function clearMemoryDraftStoreForTest(): void {
  memoryStore.clear();
}
