// Shared by the Edge Functions: which key to use for the database as the service role.

/**
 * An explicit override first, then a secret key (sb_secret_..., injected as JSON {"default": ...} on newer
 * projects; it keeps working after the legacy JWT keys are disabled), then the legacy service role JWT.
 */
export function serviceKeyFrom(env: (name: string) => string | undefined, override: string): string | undefined {
  const explicit = env(override);
  if (explicit) return explicit;
  try {
    const keys = JSON.parse(env('SUPABASE_SECRET_KEYS') ?? '{}') as Record<string, unknown>;
    const k = keys.default ?? Object.values(keys)[0];
    if (typeof k === 'string' && k) return k;
  } catch {
    // not JSON: try the legacy key
  }
  return env('SUPABASE_SERVICE_ROLE_KEY') || undefined;
}
