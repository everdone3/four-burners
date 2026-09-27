// Which records never leave this device. Shared by the sync engine and backups.
import type { FourBurnersDB } from '@/data/db';
import { SYNCED_KV_KEYS, primaryKeyOf, type Collection } from './types';

/** kv key (device-local) listing the quarter ids the dev sample-data loader created. */
export const SAMPLE_QUARTERS_KEY = 'sampleQuarters';

const isSampleId = (v: unknown) => typeof v === 'string' && v.startsWith('sample-');

/**
 * True when a record must never be pushed or backed up (and must never be overwritten by a pull):
 * sample data (ids starting "sample-", and records attached to a sample goal or person), quarters the
 * sample loader created, device-level kv keys, and malformed records without a string key.
 */
export function isLocalOnly(collection: Collection, record: Record<string, unknown>, sampleQuarterIds: ReadonlySet<string>): boolean {
  const key = record[primaryKeyOf(collection)];
  if (typeof key !== 'string' || key === '') return true;
  if (isSampleId(key)) return true;
  if (collection === 'kv') return !SYNCED_KV_KEYS.includes(key);
  if (collection === 'quarters') return sampleQuarterIds.has(key);
  if (isSampleId(record.goalId) || isSampleId(record.personId)) return true;
  return false;
}

export async function loadSampleQuarterIds(db: FourBurnersDB): Promise<Set<string>> {
  const row = await db.kv.get(SAMPLE_QUARTERS_KEY);
  return new Set(Array.isArray(row?.value) ? (row.value as unknown[]).filter((v): v is string => typeof v === 'string') : []);
}
