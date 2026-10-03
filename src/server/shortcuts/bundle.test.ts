// The deployed artifact: supabase/functions/shortcuts/index.ts must be the current bundle, and must boot and
// check tokens in a Deno-like runtime.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bundleFunction, outputOf } from '../../../scripts/build-functions.mjs';
import { generateToken } from '@/shortcuts/token';

type Handler = (req: Request) => Promise<Response>;
const OUTPUT = outputOf('shortcuts');

async function boot(env: Record<string, string>): Promise<Handler> {
  const file = join(mkdtempSync(join(tmpdir(), 'fb-shortcuts-')), 'index.mjs');
  writeFileSync(file, readFileSync(OUTPUT, 'utf8'));
  let handler: Handler | undefined;
  vi.stubGlobal('Deno', { env: { get: (n: string) => env[n] }, serve: (h: Handler) => (handler = h) });
  await import(/* @vite-ignore */ pathToFileURL(file).href);
  return handler!;
}

afterEach(() => vi.unstubAllGlobals());

describe('shortcuts bundle', () => {
  it('is up to date (run `npm run build:functions` after changing src/server or src/domain)', async () => {
    expect(readFileSync(OUTPUT, 'utf8').replace(/\r\n/g, '\n') === (await bundleFunction('shortcuts'))).toBe(true);
  }, 30_000);

  it('has no imports and no em dashes', () => {
    const src = readFileSync(OUTPUT, 'utf8');
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/—/);
  });

  it('boots, and says when it is missing its key', async () => {
    const h = await boot({ SUPABASE_URL: 'https://p.supabase.co' });
    expect((await h(new Request('https://p/shortcuts', { method: 'POST' }))).status).toBe(500);
  });

  it('looks the token up by its hash, never sending the token itself', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      return new Response('[]', { status: 200 });
    });
    const token = generateToken();
    const h = await boot({ SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SECRET_KEYS: '{"default":"sb_secret_x"}' });
    const res = await h(new Request('https://p/shortcuts', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{"action":"ping"}' }));
    expect(res.status).toBe(401);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/^https:\/\/p\.supabase\.co\/rest\/v1\/shortcut_tokens\?select=id%2Cuser_id&token_hash=eq\.[0-9a-f]{64}$/);
    expect(urls[0]).not.toContain(token);
  });
});
