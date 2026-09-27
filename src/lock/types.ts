// App lock contracts (Phase 6), shared by the lock controller, the lock screen, and Settings.
//
// THE FACE ID LOCK IS AN ACCESS GATE, NOT ENCRYPTION. Data stays unencrypted in IndexedDB. The lock keeps
// someone holding your unlocked device from casually opening the app. It does not stop anyone who can
// run script in this origin, attach Web Inspector, or read the device's storage. See webauthnLocal.ts.
//
// Everything here is per device and never synced or backed up: each device enrolls its own passkey.

/** Lock after this many minutes without interaction. 0 = every time the app leaves the screen. */
export type IdleMinutes = 0 | 1 | 5 | 15 | 60;
export const IDLE_CHOICES: readonly IdleMinutes[] = [0, 1, 5, 15, 60];
export const DEFAULT_IDLE_MINUTES: IdleMinutes = 5;

/** The enrolled passkey for this device (localStorage, so the lock is known synchronously at launch). */
export interface LockRecord {
  v: 1;
  /** location.hostname at enrollment (vercel.app is a public suffix, so rp.id is the full host). */
  rpId: string;
  /** base64url credential id. */
  credentialId: string;
  /** Public key as a JWK (ES256 from getPublicKey(), RS256 or COSE fallback). */
  publicKey: JsonWebKey;
  /** COSE algorithm (-7 ES256, -257 RS256). */
  alg: number;
  /** Shown in the Passwords app, e.g. "Four Burners lock · iPhone". */
  label: string;
  createdAt: string;
}

export type LockDevice = 'iphone' | 'ipad' | 'mac' | 'other';

/**
 * off: no lock on this device. unlocked: enrolled and open. locked: enrolled and showing the lock screen.
 * unlocking: a Face ID prompt is up.
 */
export type LockPhase = 'off' | 'unlocked' | 'locked' | 'unlocking';

export interface LockState {
  phase: LockPhase;
  idleMinutes: IdleMinutes;
  /** True until the first successful unlock of this page load: the app's screens have never been mounted. */
  coldStart: boolean;
  /** Failed or cancelled unlock attempts since the lock screen appeared (drives "Can't unlock?"). */
  failures: number;
  /** Short plain-language note for the lock screen (no em dashes). */
  message?: string;
  device: LockDevice;
  /** A lock record exists but was made for another address (a preview URL or a new domain). */
  otherHost: boolean;
  /** Result of isUserVerifyingPlatformAuthenticatorAvailable(): a hint only. */
  available: 'unknown' | 'yes' | 'no';
  /** The passkey name this device uses or would use. */
  label: string;
}

export type UnlockResult = 'ok' | 'cancelled' | 'failed' | 'not-focused' | 'busy';
export type EnableResult = 'ok' | 'cancelled' | 'failed';
export type DisableResult = 'ok' | 'cancelled' | 'failed';

export interface LockLogEntry {
  at: number;
  event: string;
  detail?: string;
}
