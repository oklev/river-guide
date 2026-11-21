import { openDB, type IDBPDatabase } from 'idb';
import type { OsmTile, Photo, PhotoBlob, RiverPoint, Route, Track } from './types';

const DB_NAME = 'river-guide';

interface Stores {
  points: RiverPoint;
  routes: Route;
  osm: OsmTile;
  tracks: Track;
  photos: Photo;
  photoBlobs: PhotoBlob;
}
type StoreName = keyof Stores;

let dbPromise: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  dbPromise ??= openDB(DB_NAME, 4, {
    upgrade(database, oldVersion) {
      if (oldVersion < 1) database.createObjectStore('points', { keyPath: 'id' });
      if (oldVersion < 2) database.createObjectStore('routes', { keyPath: 'id' });
      if (oldVersion < 3) database.createObjectStore('osm', { keyPath: 'key' });
      if (oldVersion < 4) {
        database.createObjectStore('tracks', { keyPath: 'id' });
        database.createObjectStore('photos', { keyPath: 'id' });
        database.createObjectStore('photoBlobs', { keyPath: 'id' });
      }
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

export async function get<S extends StoreName>(store: S, key: string): Promise<Stores[S] | undefined> {
  return (await db()).get(store, key);
}

export async function hasKey(store: StoreName, key: string): Promise<boolean> {
  return (await (await db()).getKey(store, key)) !== undefined;
}

export async function clearStore(store: StoreName): Promise<void> {
  await (await db()).clear(store);
}

export async function count(store: StoreName): Promise<number> {
  return (await db()).count(store);
}

export async function putMany<S extends StoreName>(store: S, values: Stores[S][]): Promise<void> {
  const tx = (await db()).transaction(store, 'readwrite');
  await Promise.all([...values.map((v) => tx.store.put(v)), tx.done]);
}
