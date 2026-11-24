/**
 * Sync merge logic, kept free of storage and network code so it can be tested
 * on its own.
 *
 * Every synced record is an Entry keyed "store:id". An entry with no `data` is
 * a deletion. Each device publishes a snapshot of everything it knows; merging
 * takes the newest revision of each key across all snapshots. Because every
 * snapshot is a full state and the rule is "newest wins", merging is
 * order-independent and repeatable: all devices converge.
 */
export interface Entry {
  rev: string;
  /** Record contents; absent for a deletion. */
  data?: Record<string, unknown>;
}
export type Entries = Map<string, Entry>;

export interface Snapshot {
  format: 1;
  device: string;
  /** Human-readable, e.g. "Chrome on Windows". */
  deviceName?: string;
  written: string;
  entries: Record<string, Entry>;
}

/** Deletions older than this are forgotten (every device has seen them by then). */
export const TOMBSTONE_DAYS = 90;

const revTime = (rev: string) => Date.parse(rev.split('~')[0]) || 0;

/** The entry with the newer revision (ties can't happen across devices: the device ID is part of the rev). */
export const newer = (a: Entry | undefined, b: Entry | undefined): Entry | undefined =>
  !a ? b : !b ? a : b.rev > a.rev ? b : a;

export interface MergeResult {
  merged: Entries;
  /** Keys whose winning entry differs from the local one: apply these locally. */
  changed: string[];
}

export function merge(local: Entries, remotes: Entries[], now = Date.now()): MergeResult {
  const merged: Entries = new Map(local);
  for (const remote of remotes) {
    for (const [key, entry] of remote) merged.set(key, newer(merged.get(key), entry)!);
  }
  const cutoff = now - TOMBSTONE_DAYS * 86_400_000;
  const changed: string[] = [];
  for (const [key, entry] of merged) {
    if (!entry.data && revTime(entry.rev) < cutoff) {
      merged.delete(key);
      continue;
    }
    if (local.get(key)?.rev !== entry.rev) changed.push(key);
  }
  return { merged, changed };
}

export const toEntries = (s: Snapshot | undefined): Entries => new Map(Object.entries(s?.entries ?? {}));

export function toSnapshot(entries: Entries, device: string, deviceName?: string): Snapshot {
  // Sorted keys keep the file stable, so "did anything change?" is a string compare.
  const sorted = [...entries.keys()].sort();
  return {
    format: 1,
    device,
    deviceName,
    written: new Date().toISOString(),
    entries: Object.fromEntries(sorted.map((k) => [k, entries.get(k)!])),
  };
}

export const splitKey = (key: string): [string, string] => {
  const i = key.indexOf(':');
  return [key.slice(0, i), key.slice(i + 1)];
};
