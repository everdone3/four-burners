/** Random UUID for new records. Works offline; safe to merge across devices. */
export function newId(): string {
  return crypto.randomUUID();
}
