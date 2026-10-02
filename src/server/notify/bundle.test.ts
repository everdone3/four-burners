// The deployed artifact itself: supabase/functions/notify/index.ts must be the current bundle of
// src/server/notify + src/domain, and must boot and answer requests in a Deno-like runtime.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OUTPUT, bundleNotify } from '../../../scripts/build-functions.mjs';

type Handler = (req: Request) => Promise<Response>;

/** Load the committed bundle the way the Edge runtime would: a fresh module, a Deno global, Deno.serve. */
async function boot(env: Record<string, string>): Promise<Handler> {
  const dir = mkdtempSync(join(tmpdir(), 'fb-notify-'));
  const file = join(dir, 'index.mjs');
  writeFileSync(file, readFileSync(OUTPUT, 'utf8'));
  let handler: Handler | undefined;
  vi.stubGlobal('Deno', { env: { get: (n: string) => env[n] }, serve: (h: Handler) => (handler = h) });
  await import(/* @vite-ignore */ pathToFileURL(file).href);
  expect(handler).toBeTypeOf('function');
  return handler!;
}

afterEach(() => vi.unstubAllGlobals());

describe('notify bundle', () => {
  it('is up to date (run `npm run build:functions` after changing src/server/notify or src/domain)', async () => {
    const committed = readFileSync(OUTPUT, 'utf8').replace(/\r\n/g, '\n');
    expect(committed === (await bundleNotify())).toBe(true);
  }, 30_000);

  it('has no imports: one file, pasteable into the Supabase dashboard', () => {
    const src = readFileSync(OUTPUT, 'utf8');
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\brequire\(/);
    expect(src).not.toMatch(/—/);
  });

  it('boots and names missing secrets', async () => {
    const h = await boot({ SUPABASE_URL: 'https://p.supabase.co' });
    const res = await h(new Request('https://p.supabase.co/functions/v1/notify', { method: 'POST' }));
    expect(res.status).toBe(500);
    expect((await res.json()).missing).toEqual(['SUPABASE_SERVICE_ROLE_KEY', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']);
  });

  it('checks the schedule secret against the database', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      return new Response('false', { status: 200 });
    });
    const h = await boot({
      SUPABASE_URL: 'https://p.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'eyJservice',
      VAPID_PUBLIC_KEY: 'p',
      VAPID_PRIVATE_KEY: 'k',
      VAPID_SUBJECT: 'mailto:a@b.c',
    });
    const res = await h(new Request('https://p.supabase.co/functions/v1/notify', { method: 'POST', headers: { 'x-notify-secret': 'guess' } }));
    expect(res.status).toBe(401);
    expect(calls).toEqual(['https://p.supabase.co/rest/v1/rpc/notify_cron_ok']);
  });
});
