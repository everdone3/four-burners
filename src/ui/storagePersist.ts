// Ask the browser to keep this app's storage (IndexedDB, the only copy until you sign in to sync) even
// when the device runs low on space. Browsers decide on their own; Home Screen apps usually qualify.
// Failures are fine to ignore: the app works the same, the data is just less protected.

let result: Promise<boolean | null> | undefined;

/** Call once at startup (main.tsx). Safe to call again; it asks only once. */
export function requestPersistentStorage(): Promise<boolean | null> {
  result ??= (async () => {
    const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
    if (!storage?.persist) return null;
    try {
      // Already granted: skip persist(), which some browsers (Firefox) turn into a prompt.
      if (await storage.persisted?.()) return true;
      return await storage.persist();
    } catch {
      return null;
    }
  })();
  return result;
}

/** true: protected from automatic clearing. false: the browser may clear it under storage pressure. null: unknown. */
export function storagePersisted(): Promise<boolean | null> {
  return requestPersistentStorage();
}
