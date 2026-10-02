// Entry point of the notify Edge Function (Supabase Edge runtime, Deno). `npm run build:functions` bundles
// this file, the handler and the domain rules into supabase/functions/notify/index.ts.
import { createHandler, readConfig } from './handler';
import { restStore } from './store';

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Response | Promise<Response>): unknown;
};

const config = readConfig((name) => Deno.env.get(name));

Deno.serve(
  config.ok
    ? createHandler({
        store: restStore(config.supabaseUrl, config.serviceKey, fetch),
        vapid: config.vapid,
        fetch,
        now: () => new Date(),
        log: (msg) => console.error(msg),
      })
    : async () =>
        new Response(JSON.stringify({ error: 'The notify function is missing secrets.', missing: config.missing }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
);
