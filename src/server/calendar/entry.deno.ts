// Entry point of the calendar Edge Function (Supabase Edge runtime, Deno). `npm run build:functions` bundles
// this file, the handler and the domain rules into supabase/functions/calendar/index.ts.
import { serviceKeyFrom } from '../env';
import { createCalendarHandler } from './handler';

declare const Deno: {
  env: { get(name: string): string | undefined };
  resolveDns?(name: string, type: 'A' | 'AAAA'): Promise<string[]>;
  serve(handler: (req: Request) => Response | Promise<Response>): unknown;
};

const env = (name: string) => Deno.env.get(name);
const supabaseUrl = env('SUPABASE_URL')?.replace(/\/+$/, '');
// Only used to ask the Auth server who a sign-in token belongs to.
const apiKey = serviceKeyFrom(env, 'CALENDAR_SERVICE_KEY') ?? env('SUPABASE_ANON_KEY');

Deno.serve(
  supabaseUrl && apiKey
    ? createCalendarHandler({
        async userFromToken(token) {
          const res = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: apiKey, Authorization: `Bearer ${token}` } });
          if (!res.ok) return null;
          const user = (await res.json().catch(() => null)) as { id?: unknown } | null;
          return typeof user?.id === 'string' ? user.id : null;
        },
        fetch,
        async resolve(host) {
          // Where the runtime can't look names up, fall back to the name checks alone (null).
          if (typeof Deno.resolveDns !== 'function') return null;
          const [a, aaaa] = await Promise.allSettled([Deno.resolveDns(host, 'A'), Deno.resolveDns(host, 'AAAA')]);
          if (a.status === 'rejected' && aaaa.status === 'rejected') return null;
          return [...(a.status === 'fulfilled' ? a.value : []), ...(aaaa.status === 'fulfilled' ? aaaa.value : [])];
        },
        now: () => new Date(),
        log: (msg) => console.error(msg),
      })
    : async () =>
        new Response(JSON.stringify({ ok: false, message: 'The calendar function is missing SUPABASE_URL or its key.' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
);
