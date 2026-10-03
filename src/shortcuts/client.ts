// Settings > Shortcuts and Siri: make, list and revoke personal tokens for Apple Shortcuts.
// The token is made here and shown once; only its SHA-256 hash is sent to the server (src/shortcuts/token.ts).
import { getClient, getSyncConfig } from '@/sync/client';
import { generateToken, hashToken } from './token';

export interface TokenInfo {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt?: string;
}

/** The address every Shortcut calls. Null when this build has no Supabase project. */
export function shortcutsEndpoint(): string | null {
  const c = getSyncConfig();
  return c ? `${c.url}/functions/v1/shortcuts` : null;
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await (await getClient()).rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export async function listTokens(): Promise<TokenInfo[]> {
  const rows = await rpc<{ id: string; label: string; created_at: string; last_used_at: string | null }[]>('shortcut_tokens_list');
  return (rows ?? []).map((r) => ({ id: r.id, label: r.label, createdAt: r.created_at, lastUsedAt: r.last_used_at ?? undefined }));
}

/** Make a token. The returned token is the only copy anywhere: show it once and let it be copied. */
export async function createToken(label: string): Promise<{ id: string; token: string }> {
  const token = generateToken();
  const id = await rpc<string>('shortcut_token_create', { p_hash: await hashToken(token), p_label: label.trim().slice(0, 60) });
  return { id, token };
}

export async function revokeToken(id: string): Promise<boolean> {
  return rpc<boolean>('shortcut_token_revoke', { p_id: id });
}

/** Plain words for an RPC failure. */
export function tokenError(e: unknown): string {
  const msg = e instanceof Error ? e.message : '';
  if (/at most 10/.test(msg)) return 'You have 10 tokens already. Revoke one you no longer use first.';
  if (/shortcut_token|function .* does not exist|schema cache/i.test(msg) && !/not signed in/.test(msg))
    return "The server isn't set up for Shortcuts yet. See README > Shortcuts and Siri.";
  if (/not signed in|JWT/i.test(msg)) return 'Sign in under Sync across devices first.';
  return "Couldn't reach the server. Check your connection and try again.";
}
