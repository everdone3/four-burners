// Shared markers used by the packet builder and the reply parser. Change them in one place only.

/** First line of every packet. Also lets the paste box notice when the packet itself was pasted back. */
export const PACKET_HEADER = 'FOUR BURNERS COACH v1';

/** Last line of every packet. The coach is told to say so if it is missing (paste was cut off). */
export const PACKET_END = 'END OF PACKET';

/** Soft size budgets in characters of the final redacted packet. Over budget shows amber; copy is never blocked. */
export const PACKET_BUDGETS = {
  onboarding: 3000,
  weekly: 5000,
  checkin: 4500,
  quarter_setup: 5500,
} as const;

/** Placeholder that replaces sensitive terms. */
export { REDACTED } from './redact';
