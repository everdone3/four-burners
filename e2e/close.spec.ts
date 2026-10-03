// Core flow 3: the quarter close. Highlights reel, grading, carry forward or drop, then next quarter's setup.
import { expect, test } from '@playwright/test';
import { go, home, liveRecords, loadSampleData, openApp, skipOnboarding, timeTravel } from './helpers';

interface G {
  id: string;
  title: string;
  quarterId: string;
  grade?: string;
  closeDecision?: string;
  carriedFromId?: string;
}

test('quarter close: highlights, grades, carry and drop, then set up the next quarter', async ({ page }) => {
  await openApp(page);
  await skipOnboarding(page);
  await loadSampleData(page);
  const thisQuarter = (await liveRecords<{ id: string; status: string }>(page, 'quarters')).find((q) => q.status === 'active' && !q.id.startsWith('sample'))!.id;
  const quarterGoals = (await liveRecords<G>(page, 'goals')).filter((g) => g.quarterId === thisQuarter);
  expect(quarterGoals.length).toBeGreaterThan(2);

  await timeTravel(page, 'First day of next quarter');
  await home(page);

  // The close card on Home starts the highlights reel.
  await page.getByRole('button', { name: /Watch your highlights/ }).click();
  await expect(page.getByText(/highlights$/i).first()).toBeVisible();
  const grade = page.getByRole('button', { name: 'Grade your goals' });
  // Tap through the slides (they also advance on their own; the last one covers the tap zone with its button).
  for (let i = 0; i < 12 && !(await grade.isVisible()); i++) {
    await page.getByRole('button', { name: 'Next', exact: true }).click({ force: true, timeout: 2000 }).catch(() => undefined);
    await page.waitForTimeout(300);
  }
  await grade.click();

  // Grading: every goal has a suggested grade and decision; change two of them.
  await expect(page.getByText('Quarter close', { exact: true })).toBeVisible();
  const [first, second] = quarterGoals;
  await page.getByRole('radiogroup', { name: `Grade for ${first.title}` }).getByRole('radio').first().click();
  await page.getByRole('radiogroup', { name: `Next quarter for ${first.title}` }).getByRole('radio', { name: /Carry forward/ }).click();
  await page.getByRole('radiogroup', { name: `Next quarter for ${second.title}` }).getByRole('radio', { name: /Drop/ }).click();
  await expect
    .poll(async () => (await liveRecords<G>(page, 'goals')).find((g) => g.id === first.id))
    .toMatchObject({ grade: 'A', closeDecision: 'carry' });

  await page.getByRole('button', { name: /^Close .* and carry forward$/ }).click();

  // Closed: frozen, carried goals copied into the next quarter, dropped ones not.
  await expect.poll(async () => (await liveRecords<{ id: string; status: string }>(page, 'quarters')).find((q) => q.id === thisQuarter)?.status).toBe('closed');
  const after = await liveRecords<G>(page, 'goals');
  const carried = after.filter((g) => g.carriedFromId && g.quarterId !== thisQuarter);
  expect(carried.some((g) => g.carriedFromId === first.id && g.title === first.title)).toBe(true);
  expect(carried.some((g) => g.carriedFromId === second.id)).toBe(false);

  // Next quarter's setup opens, pre-filled with what was carried.
  await expect(page).toHaveURL(/#\/setup\//);
  await expect(page.getByText(first.title).first()).toBeVisible();

  // The archive keeps the closed quarter.
  await go(page, `#/archive/${thisQuarter}`);
  await expect(page.getByText(new RegExp(thisQuarter.replace('-', ' ').replace(/^(\d+) (Q\d)$/, '$2 $1'))).first()).toBeVisible();
});
