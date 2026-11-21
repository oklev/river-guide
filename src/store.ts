import { openDB, type IDBPDatabase } from 'idb';
import type { RiverPoint, Route } from './types';

const DB_NAME = 'river-guide';

interface Stores {
  points: RiverPoint;
  routes: Route;
}
type StoreName = keyof Stores;

let dbPromise: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  dbPromise ??= openDB(DB_NAME, 2, {
    upgrade(database, oldVersion) {
      if (oldVersion < 1) database.createObjectStore('points', { keyPath: 'id' });
      if (oldVersion < 2) database.createObjectStore('routes', { keyPath: 'id' });
    },
  });
  return dbPromise;
}

export async function getAll<S extends StoreName>(store: S): Promise<Stores[S][]> {
  return (await db()).getAll(store);
}

export async function put<S extends StoreName>(store: S, value: Stores[S]): Promise<void> {
  await (await db()).put(store, value);
}

export async function del(store: StoreName, id: string): Promise<void> {
  await (await db()).delete(store, id);
}

export async function putMany<S extends StoreName>(store: S, values: Stores[S][]): Promise<void> {
  const tx = (await db()).transaction(store, 'readwrite');
  await Promise.all([...values.map((v) => tx.store.put(v)), tx.done]);
}
