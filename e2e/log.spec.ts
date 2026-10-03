// Core flow 1: logging in two taps, the 5-second undo, a private note, and the dashboard reacting.
import { expect, test } from '@playwright/test';
import { home, liveRecords, loadSampleData, openApp, skipOnboarding } from './helpers';

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await skipOnboarding(page);
  await loadSampleData(page);
  await home(page);
});

test('log a goal from Home in two taps, undo it, then log with a private note', async ({ page }) => {
  const before = (await liveRecords(page, 'logs')).length;

  // Tap 1: the Log button. Tap 2: a goal.
  await page.getByRole('button', { name: /^\+\s*Log$/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Log progress' });
  await expect(sheet).toBeVisible();
  const goal = sheet.getByRole('button', { name: /^Log / }).first();
  const title = ((await goal.getAttribute('aria-label')) ?? '').replace(/^Log /, '');
  await goal.click();

  const toast = page.getByText(/^Logged |complete$/).first();
  await expect(toast).toBeVisible();
  await expect.poll(async () => (await liveRecords(page, 'logs')).length).toBe(before + 1);

  // Undo inside the toast's 5 seconds.
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await liveRecords(page, 'logs')).length).toBe(before);

  // The sheet stays open: log again and add a private note from the toast.
  await sheet.getByRole('button', { name: `Log ${title}`, exact: true }).click();
  await page.getByRole('button', { name: 'Note' }).click();
  const noteBox = page.getByRole('dialog').getByRole('textbox');
  await noteBox.fill('Felt great, private detail');
  await page.getByRole('switch', { name: /private/i }).or(page.getByRole('checkbox', { name: /private/i })).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();

  await expect
    .poll(async () => (await liveRecords<{ note?: string; notePrivate?: boolean }>(page, 'logs')).find((l) => l.note === 'Felt great, private detail'))
    .toMatchObject({ notePrivate: true });
});

test('a burner screen shows its goals, and logging there updates progress', async ({ page }) => {
  await page.getByRole('button', { name: /^Health,/ }).click();
  await expect(page).toHaveURL(/#\/burner\/health/);
  // A Habit goal logs in one tap (a Number goal opens amount chips instead).
  const logButton = page.getByRole('button', { name: 'Log Strength training' });
  await expect(logButton).toBeVisible();
  const before = (await liveRecords(page, 'logs')).length;
  await logButton.click();
  await expect.poll(async () => (await liveRecords(page, 'logs')).length).toBe(before + 1);
});
