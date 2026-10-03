// Shared steps for the end-to-end tests.
import { expect, type Page } from '@playwright/test';

/**
 * Open the app fresh. The clipboard is replaced with a recorder (window.__clip holds the last copy) so the
 * coach packet can be checked, and window.open is captured so no test ever leaves for claude.ai.
 */
export async function openApp(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __clip: string; __opened: string[] };
    w.__clip = '';
    w.__opened = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (t: string) => {
          w.__clip = t;
        },
        readText: async () => w.__clip,
      },
    });
    window.open = ((url?: string | URL) => {
      w.__opened.push(String(url));
      return null;
    }) as typeof window.open;
  });
  await page.goto('/');
}

/** A fresh install lands in the onboarding interview: put it off. */
export async function skipOnboarding(page: Page) {
  await expect(page).toHaveURL(/#\/onboarding/);
  await page.getByRole('button', { name: 'Later' }).first().click();
  await expect(page).toHaveURL(/#\/?$/);
}

/** Go to a screen the way the app does (a hash change), once the app is up and listening. */
export async function go(page: Page, hash: string) {
  await page.waitForFunction(() => !!document.querySelector('main'));
  await page.evaluate((h) => {
    location.hash = h;
  }, hash);
}

export async function openSettings(page: Page) {
  await go(page, '#/settings');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
}

/**
 * The dev menu's "Load sample data" (a closed last quarter and this quarter so far), run directly and then
 * reloaded: the desktop WebKit build is slow, and doing it behind live screens makes it slower still.
 */
export async function loadSampleData(page: Page) {
  await page.evaluate(async () => {
    const sample = await import('/src/data/sample.ts');
    await sample.loadSampleData();
  });
  await page.reload();
}

/** Settings > Developer > Time travel. */
export async function timeTravel(page: Page, to: 'Next Sunday' | 'First day of next quarter') {
  await openSettings(page);
  await page.getByRole('button', { name: to }).click();
  await expect(page.getByText(/Active: today is/)).toBeVisible();
}

export async function home(page: Page) {
  await go(page, '#/');
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
}

/** What the app last copied to the clipboard. */
export const clipboard = (page: Page) => page.evaluate(() => (window as unknown as { __clip: string }).__clip);

/** Records in one IndexedDB table (live ones only). */
export function liveRecords<T = Record<string, unknown>>(page: Page, table: string): Promise<T[]> {
  return page.evaluate(
    (t) =>
      new Promise<T[]>((resolve, reject) => {
        const open = indexedDB.open('four-burners');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const req = open.result.transaction(t).objectStore(t).getAll();
          req.onsuccess = () => resolve((req.result as (T & { deleted?: boolean })[]).filter((r) => !r.deleted));
          req.onerror = () => reject(req.error);
        };
      }),
    table,
  );
}

/** Pretend the app went to the background and came back (as after switching to the Claude app). */
export async function returnToApp(page: Page) {
  await page.evaluate(() => {
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    window.dispatchEvent(new Event('focus'));
  });
}
