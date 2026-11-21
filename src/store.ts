import { openDB, type IDBPDatabase } from 'idb';
import type { RiverPoint } from './types';

const DB_NAME = 'river-guide';
const STORE = 'points';

let dbPromise: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  dbPromise ??= openDB(DB_NAME, 1, {
    upgrade(database) {
      database.createObjectStore(STORE, { keyPath: 'id' });
    },
  });
  return dbPromise;
}

export async function listPoints(): Promise<RiverPoint[]> {
  return (await db()).getAll(STORE);
}

export async function savePoint(point: RiverPoint): Promise<void> {
  await (await db()).put(STORE, point);
}

export async function deletePoint(id: string): Promise<void> {
  await (await db()).delete(STORE, id);
}

export async function savePoints(points: RiverPoint[]): Promise<void> {
  const tx = (await db()).transaction(STORE, 'readwrite');
  await Promise.all([...points.map((p) => tx.store.put(p)), tx.done]);
}
