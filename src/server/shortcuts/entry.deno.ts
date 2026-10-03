// Entry point of the shortcuts Edge Function (Supabase Edge runtime, Deno). `npm run build:functions` bundles
// this file, the handler and the domain rules into supabase/functions/shortcuts/index.ts.
import { serviceKeyFrom } from '../env';
import { createShortcutsHandler } from './handler';
import { restShortcutsStore } from './store';

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Response | Promise<Response>): unknown;
};

const env = (name: string) => Deno.env.get(name);
const supabaseUrl = env('SUPABASE_URL');
const serviceKey = serviceKeyFrom(env, 'SHORTCUTS_SERVICE_KEY');

Deno.serve(
  supabaseUrl && serviceKey
    ? createShortcutsHandler({
        store: restShortcutsStore(supabaseUrl, serviceKey, fetch),
        now: () => new Date(),
        newId: () => crypto.randomUUID(),
        log: (msg) => console.error(msg),
      })
    : async () =>
        new Response(JSON.stringify({ ok: false, message: 'The shortcuts function is missing SUPABASE_URL or its service key.' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
);
