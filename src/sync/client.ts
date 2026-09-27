// The Supabase client, loaded on demand. Builds without VITE_SUPABASE_URL and a key are "unconfigured":
// nothing here loads, and the app works exactly as it did before sync.
//
// The publishable key (sb_publishable_..., or the legacy anon key) is browser-safe by design: Row Level
// Security on the server decides what a signed-in user can read and write.
import type { SupabaseClient } from '@supabase/supabase-js';

/** The env vars this module reads (declared here rather than globally, so nothing else has to change). */
interface SyncEnv {
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  /** Legacy name, accepted as a fallback. */
  VITE_SUPABASE_ANON_KEY?: string;
}

export interface SyncConfig {
  url: string;
  key: string;
}

export function getSyncConfig(): SyncConfig | null {
  const env = import.meta.env as unknown as SyncEnv;
  const url = env.VITE_SUPABASE_URL?.trim().replace(/\/+$/, '');
  const key = (env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() || env.VITE_SUPABASE_ANON_KEY?.trim()) ?? '';
  if (!url || !key) return null;
  try {
    new URL(url);
  } catch {
    return null;
  }
  return { url, key };
}

export function isSyncConfigured(): boolean {
  return getSyncConfig() !== null;
}

/** Where supabase-js keeps the session: localStorage `sb-<project-ref>-auth-token`. */
export function authStorageKey(config: SyncConfig | null = getSyncConfig()): string | null {
  return config ? `sb-${new URL(config.url).hostname.split('.')[0]}-auth-token` : null;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export interface StoredUser {
  id: string;
  email?: string;
}

/**
 * The user in the saved session, read straight from storage. It survives an expired access token and
 * being offline, so the UI can show who is signed in before (or without) any network.
 */
export function readStoredSession(): StoredUser | null {
  const key = authStorageKey();
  const raw = key ? storage()?.getItem(key) : null;
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as { refresh_token?: unknown; user?: { id?: unknown; email?: unknown } };
    if (typeof s.refresh_token !== 'string' || typeof s.user?.id !== 'string') return null;
    return { id: s.user.id, email: typeof s.user.email === 'string' ? s.user.email : undefined };
  } catch {
    return null;
  }
}

/** True while a saved session (with its refresh token) is on this device, even if it can't refresh right now. */
export function hasStoredSession(): boolean {
  const key = authStorageKey();
  return !!key && !!storage()?.getItem(key);
}

/** Forget the saved session on this device (used when signing out offline, where supabase-js keeps it). */
export function clearStoredSession(): void {
  const key = authStorageKey();
  const s = storage();
  if (!key || !s) return;
  for (const k of [key, `${key}-user`, `${key}-code-verifier`]) s.removeItem(k);
}

/** Longest a single request may take. iOS can leave a fetch hanging across a suspend; a run must never stall. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** fetch with a timeout (and the caller's own abort signal still honored). A timeout rejects like a network error. */
export function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException('The request timed out.', 'TimeoutError')), REQUEST_TIMEOUT_MS);
  const outer = init.signal;
  if (outer) {
    if (outer.aborted) ctrl.abort(outer.reason);
    else outer.addEventListener('abort', () => ctrl.abort(outer.reason), { once: true });
  }
  return fetch(input, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

let clientPromise: Promise<SupabaseClient> | null = null;

/** The shared client. supabase-js loads with the first call, so it stays out of the main bundle. */
export function getClient(): Promise<SupabaseClient> {
  const config = getSyncConfig();
  if (!config) return Promise.reject(new Error('Sync is not configured in this build.'));
  clientPromise ??= import('@supabase/supabase-js')
    .then(({ createClient }) =>
      createClient(config.url, config.key, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
        global: { fetch: fetchWithTimeout },
      }),
    )
    .catch((e: unknown) => {
      // Offline before the chunk was ever cached: try again next time.
      clientPromise = null;
      throw e;
    });
  return clientPromise;
}
