import { afterEach, describe, expect, it, vi } from 'vitest';
import { REQUEST_TIMEOUT_MS, authStorageKey, clearStoredSession, fetchWithTimeout, getSyncConfig, hasStoredSession, isSyncConfigured, readStoredSession } from './client';
import {
  GENERIC_MESSAGE,
  PAUSED_MESSAGE,
  SERVER_MESSAGE,
  SETUP_MESSAGE,
  SyncError,
  classifyRpcFailure,
  createSupabaseRemote,
  toSyncError,
  type RpcClient,
  type RpcResponse,
} from './remote';
import type { RemoteRow } from './types';

function fakeClient(respond: (fn: string, args: Record<string, unknown>) => RpcResponse | Promise<RpcResponse>) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const client: RpcClient = {
    rpc: (fn, args = {}) => {
      calls.push({ fn, args });
      return Promise.resolve(respond(fn, args));
    },
  };
  return { client, calls };
}

const ok = (data: unknown): RpcResponse => ({ data, error: null, status: 200 });

async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    return e instanceof SyncError ? e.kind : `other: ${String(e)}`;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createSupabaseRemote', () => {
  it('pushes rows through push_records with exactly the server fields', async () => {
    const { client, calls } = fakeClient(() => ok(2));
    const rows: RemoteRow[] = [
      { collection: 'goals', id: 'g1', data: { id: 'g1', title: 'Run' }, updated_at: '2026-09-01T10:00:00.000Z', deleted: false },
      { collection: 'kv', id: 'settings', data: { key: 'settings', value: {} }, updated_at: '2026-09-01T11:00:00.000Z', deleted: true },
    ];
    await createSupabaseRemote(client).push(rows);
    expect(calls).toEqual([
      {
        fn: 'push_records',
        args: {
          p_rows: [
            { collection: 'goals', id: 'g1', data: { id: 'g1', title: 'Run' }, updated_at: '2026-09-01T10:00:00.000Z', deleted: false },
            { collection: 'kv', id: 'settings', data: { key: 'settings', value: {} }, updated_at: '2026-09-01T11:00:00.000Z', deleted: true },
          ],
        },
      },
    ]);
  });

  it('skips the call for an empty push', async () => {
    const { client, calls } = fakeClient(() => ok(0));
    await createSupabaseRemote(client).push([]);
    expect(calls).toHaveLength(0);
  });

  it('maps a null cursor to p_after_ts null and a cursor to its three parts', async () => {
    const { client, calls } = fakeClient(() => ok([]));
    const remote = createSupabaseRemote(client);
    await remote.pull(null, 200);
    await remote.pull({ ts: '2026-09-01T10:00:00.123456Z', collection: 'goals', id: 'g9' }, 50);
    expect(calls).toEqual([
      { fn: 'pull_records', args: { p_after_ts: null, p_after_collection: '', p_after_id: '', p_limit: 200 } },
      { fn: 'pull_records', args: { p_after_ts: '2026-09-01T10:00:00.123456Z', p_after_collection: 'goals', p_after_id: 'g9', p_limit: 50 } },
    ]);
  });

  it('returns pulled rows as PulledRow, keeping server strings as they are', async () => {
    const row = { collection: 'goals', id: 'g1', data: { id: 'g1' }, updated_at: '2026-09-01T10:00:00.000Z', deleted: false, server_updated_at: '2026-09-01T10:00:01.000001Z' };
    const { client } = fakeClient(() => ok([row, { ...row, id: 'g2', deleted: true }]));
    const rows = await createSupabaseRemote(client).pull(null, 200);
    expect(rows).toEqual([row, { ...row, id: 'g2', deleted: true }]);
  });

  it('never turns a row without an object body into an empty record (the engine skips it)', async () => {
    const row = { collection: 'goals', id: 'g1', data: null, updated_at: '2026-09-01T10:00:00.000Z', deleted: false, server_updated_at: '2026-09-01T10:00:01.000001Z' };
    const { client } = fakeClient(() => ok([row, { ...row, id: 'g2', data: [1] }]));
    const rows = await createSupabaseRemote(client).pull(null, 200);
    // Same page length, so paging is not cut short; the bodies stay unusable rather than becoming {}.
    expect(rows).toHaveLength(2);
    expect(rows[0].data).toBeNull();
    expect(rows[1].data).toEqual([1]);
  });

  it('rejects a malformed pull reply as a server error', async () => {
    const { client } = fakeClient(() => ok({ nope: true }));
    expect(await kindOf(createSupabaseRemote(client).pull(null, 10))).toBe('server');
    const { client: c2 } = fakeClient(() => ok([{ collection: 'goals' }]));
    expect(await kindOf(createSupabaseRemote(c2).pull(null, 10))).toBe('server');
  });

  it('turns rpc errors and thrown fetch errors into SyncError', async () => {
    const auth = fakeClient(() => ({ data: null, error: { code: 'PGRST303', message: 'JWT expired' }, status: 401 }));
    expect(await kindOf(createSupabaseRemote(auth.client).push([{ collection: 'goals', id: 'g', data: {}, updated_at: 'x', deleted: false }]))).toBe('auth');
    const thrown: RpcClient = { rpc: () => Promise.reject(new TypeError('Failed to fetch')) };
    expect(await kindOf(createSupabaseRemote(thrown).pull(null, 10))).toBe('offline');
  });
});

describe('classifyRpcFailure', () => {
  it('is offline whenever the browser says so', () => {
    expect(classifyRpcFailure({ error: { message: 'boom' }, status: 500 }, false).kind).toBe('offline');
  });

  it('is offline when the request got no response', () => {
    const e = classifyRpcFailure({ error: { message: 'TypeError: Failed to fetch', details: '', code: '' }, status: 0 }, true);
    expect(e.kind).toBe('offline');
    expect(e.message).not.toMatch(/—/);
  });

  it('is paused when the host refuses or does not resolve while online', () => {
    expect(classifyRpcFailure({ error: { message: 'TypeError: fetch failed', details: 'Caused by: Error: connect (ECONNREFUSED)' }, status: 0 }, true).kind).toBe('paused');
    expect(classifyRpcFailure({ error: { message: 'TypeError: fetch failed', details: 'getaddrinfo ENOTFOUND x.supabase.co' }, status: 0 }, true).kind).toBe('paused');
  });

  it('is auth for 401s and JWT problems', () => {
    expect(classifyRpcFailure({ error: { code: '42501', message: 'push_records: not signed in' }, status: 401 }, true).kind).toBe('auth');
    expect(classifyRpcFailure({ error: { code: 'PGRST301', message: 'JWSError' }, status: 401 }, true).kind).toBe('auth');
    expect(classifyRpcFailure({ error: { message: 'JWT expired' }, status: 400 }, true).kind).toBe('auth');
  });

  it('is paused (with the Supabase hint) for 5xx and 540', () => {
    for (const status of [500, 502, 503, 540]) {
      const e = classifyRpcFailure({ error: { message: 'down' }, status }, true);
      expect(e.kind).toBe('paused');
      expect(e.message).toBe(PAUSED_MESSAGE);
    }
  });

  it('is server for anything else', () => {
    expect(classifyRpcFailure({ error: { code: '22023', message: 'p_rows must be a JSON array' }, status: 400 }, true).kind).toBe('server');
    expect(classifyRpcFailure({ error: { code: 'PGRST202', message: 'Could not find the function' }, status: 404 }, true).kind).toBe('server');
    expect(classifyRpcFailure({ error: { code: '42501', message: 'permission denied' }, status: 403 }, true).kind).toBe('server');
  });

  it('says so when the server has no sync functions or table yet (retrying will not fix it)', () => {
    for (const code of ['PGRST202', '42P01', '42883']) {
      const e = classifyRpcFailure({ error: { code, message: 'missing' }, status: 404 }, true);
      expect(e.kind).toBe('server');
      expect(e.message).toBe(SETUP_MESSAGE);
      expect(e.message).not.toMatch(/—|–/);
    }
    expect(classifyRpcFailure({ error: { code: '22023', message: 'bad' }, status: 400 }, true).message).toBe(SERVER_MESSAGE);
  });
});

describe('toSyncError', () => {
  it('classifies thrown values', () => {
    expect(toSyncError(new TypeError('Load failed'), true).kind).toBe('offline');
    expect(toSyncError(new Error('NetworkError when attempting to fetch resource.'), true).kind).toBe('offline');
    expect(toSyncError(new Error('something odd'), true).kind).toBe('server');
    expect(toSyncError(new Error('something odd'), false).kind).toBe('offline');
    const e = new SyncError('auth');
    expect(toSyncError(e)).toBe(e);
  });

  it('reads navigator.onLine by default', () => {
    vi.stubGlobal('navigator', { onLine: false });
    expect(toSyncError(new Error('x')).kind).toBe('offline');
    expect(classifyRpcFailure({ error: { message: 'x' }, status: 500 }).kind).toBe('offline');
  });

  it('only calls a TypeError offline when it is a network failure', () => {
    for (const msg of ['Failed to fetch', 'Load failed', 'fetch failed', 'The network connection was lost.', 'The Internet connection appears to be offline.']) {
      expect(toSyncError(new TypeError(msg), true).kind, msg).toBe('offline');
    }
    // A bug is not a network problem: it must show as an error (and back off), never as "offline".
    const bug = toSyncError(new TypeError("Cannot read properties of undefined (reading 'id')"), true);
    expect(bug.kind).toBe('server');
    expect(bug.message).toBe(GENERIC_MESSAGE);
  });

  it('treats timeouts as offline and local failures as a general problem', () => {
    expect(toSyncError(new DOMException('The request timed out.', 'TimeoutError'), true).kind).toBe('offline');
    expect(classifyRpcFailure({ error: { message: 'TimeoutError: The request timed out.', hint: 'Request was aborted' }, status: 0 }, true).kind).toBe('offline');
    expect(toSyncError(new Error('QuotaExceededError'), true).message).toBe(GENERIC_MESSAGE);
  });
});

describe('client config and saved session', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('needs both a URL and a key, accepting the legacy anon key', () => {
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', '');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');
    expect(getSyncConfig()).toBeNull();
    expect(isSyncConfigured()).toBe(false);
    vi.stubEnv('VITE_SUPABASE_URL', 'https://abcd.supabase.co/');
    expect(getSyncConfig()).toBeNull();
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
    expect(getSyncConfig()).toEqual({ url: 'https://abcd.supabase.co', key: 'anon-key' });
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_x');
    expect(getSyncConfig()).toEqual({ url: 'https://abcd.supabase.co', key: 'sb_publishable_x' });
    expect(authStorageKey()).toBe('sb-abcd-auth-token');
    vi.stubEnv('VITE_SUPABASE_URL', 'not a url');
    expect(getSyncConfig()).toBeNull();
  });

  it('reads, detects, and clears the saved session in localStorage', () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://abcd.supabase.co');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_x');
    const m = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => m.set(k, v), removeItem: (k: string) => m.delete(k) });
    expect(readStoredSession()).toBeNull();
    expect(hasStoredSession()).toBe(false);
    m.set('sb-abcd-auth-token', JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: 1, user: { id: 'u1', email: 'me@example.com' } }));
    m.set('sb-abcd-auth-token-code-verifier', 'v');
    m.set('other', 'keep');
    expect(readStoredSession()).toEqual({ id: 'u1', email: 'me@example.com' });
    expect(hasStoredSession()).toBe(true);
    clearStoredSession();
    expect([...m.keys()]).toEqual(['other']);
    m.set('sb-abcd-auth-token', '{broken');
    expect(readStoredSession()).toBeNull();
  });
});

describe('fetchWithTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // A fetch that only settles when its signal aborts.
  const hangingFetch = () =>
    vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(init.signal!.reason))));

  it('rejects with a TimeoutError when a request hangs', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch());
    const p = fetchWithTimeout('https://abcd.supabase.co/rest/v1/rpc/pull_records');
    const settled = p.then(
      () => 'resolved',
      (e: unknown) => (e as { name?: string }).name,
    );
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled).toBe('TimeoutError');
  });

  it('passes the caller abort through and returns responses untouched', async () => {
    vi.stubGlobal('fetch', hangingFetch());
    const ctrl = new AbortController();
    const p = fetchWithTimeout('https://x', { signal: ctrl.signal });
    ctrl.abort(new DOMException('stop', 'AbortError'));
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    const res = new Response('[]', { status: 200 });
    vi.stubGlobal('fetch', vi.fn(async () => res));
    expect(await fetchWithTimeout('https://x')).toBe(res);
  });
});

describe('refused rows (SyncError.rejected)', () => {
  it('flags bad values, constraint failures, unreadable bodies and oversized requests, and nothing else', () => {
    const r = (status: number, code?: string) => classifyRpcFailure({ status, error: { message: 'x', code } }, true);
    expect(r(400, '22P02').rejected).toBe(true);
    expect(r(400, '22P05').rejected).toBe(true);
    expect(r(400, '23514').rejected).toBe(true);
    expect(r(400, 'PGRST102').rejected).toBe(true);
    expect(r(413).rejected).toBe(true);
    expect(r(404, 'PGRST202').rejected).toBe(false); // migration missing: splitting would not help
    expect(r(400, 'PGRST100').rejected).toBe(false);
    expect(r(401, '42501').rejected).toBe(false);
    expect(r(503).rejected).toBe(false);
  });
});
