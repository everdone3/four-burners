// Core flow 2: the weekly review, including the copy-and-paste coaching loop through the Claude app.
import { expect, test } from '@playwright/test';
import { clipboard, home, liveRecords, loadSampleData, openApp, returnToApp, skipOnboarding, timeTravel } from './helpers';

const PRIVATE = 'PRIVATE pineapple note';

test('weekly review: wins, misses, coach copy and paste, actions, sealed; resumes after a reload', async ({ page }) => {
  await openApp(page);
  await skipOnboarding(page);
  await loadSampleData(page);
  await timeTravel(page, 'Next Sunday');

  // A log this week with a private note (made through the app's own write path; the log flow itself is
  // covered by log.spec.ts): it must never reach the coach packet.
  await page.evaluate(async (note) => {
    const { db } = await import('/src/data/db.ts');
    const repo = await import('/src/data/repo.ts');
    const goal = (await db.goals.toArray()).find((g) => g.title === 'Strength training' && !g.deleted);
    await repo.logProgress(goal!, 1, { note, notePrivate: true });
  }, PRIVATE);
  await expect.poll(async () => (await liveRecords<{ note?: string }>(page, 'logs')).some((l) => l.note === PRIVATE)).toBe(true);

  // The review card is on Home on review day.
  await home(page);
  await page.getByRole('button', { name: /Weekly review/ }).first().click();
  await expect(page).toHaveURL(/#\/review/);
  const heading = (name: string) => page.getByRole('heading', { level: 1, name });
  const next = () => page.getByRole('button', { name: /^(Next|Skip for now)$/ }).click();

  // Step 1: the auto-summary.
  await expect(heading('Your week')).toBeVisible();
  await next();

  // Step 2: wins.
  await expect(heading('Wins')).toBeVisible();
  await page.getByPlaceholder('Home for dinner four nights').fill('Cooked dinner three nights');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Cooked dinner three nights')).toBeVisible();
  await next();

  // Step 3: misses, then the app closes mid-review and reopens on the same step.
  await expect(heading('Misses')).toBeVisible();
  await page.getByPlaceholder("Skipped Thursday's run").fill('Missed two runs');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Missed two runs')).toBeVisible();
  await page.goto('/');
  await expect(page).toHaveURL(/#\/review/);
  await expect(heading('Misses')).toBeVisible();
  await expect(page.getByText('Missed two runs')).toBeVisible();
  await next();

  // Step 4: coaching. Copy the packet for Claude.
  await expect(heading('Coach')).toBeVisible();
  await page.getByRole('button', { name: 'Copy for Claude' }).click();
  await expect(page.getByRole('link', { name: /Open Claude/ }).or(page.getByRole('button', { name: /Open Claude/ })).first()).toBeVisible();
  const packet = await clipboard(page);
  expect(packet).toContain('Cooked dinner three nights');
  expect(packet).toContain('Missed two runs');
  expect(packet).not.toContain('pineapple');
  expect(packet).not.toMatch(/—/);

  // Coming back from the Claude app opens the paste box on its own.
  await returnToApp(page);
  const pasteBox = page.getByPlaceholder("Copy Claude's reply in the Claude app, then paste it here");
  await expect(pasteBox).toBeVisible();
  await pasteBox.fill(
    [
      'You showed up for dinner, and that is the point of Family on High. The runs slipped twice; your why was energy for the kids.',
      '',
      'Suggested actions:',
      '- Book the sitter for Friday',
      '- Run Tuesday and Thursday at 6 AM',
      '- Text Jake about the game',
    ].join('\n'),
  );
  await page.getByRole('button', { name: 'Save reply' }).click();
  await page.getByRole('button', { name: 'Add "Book the sitter for Friday" to actions' }).click();
  await expect(page.getByRole('button', { name: 'Book the sitter for Friday added' })).toBeVisible();
  await expect.poll(async () => (await liveRecords(page, 'coachReplies')).length).toBeGreaterThan(0);

  // Step 5: focus. Step 6: the action from the coach is already there. Seal the week.
  await next();
  await expect(heading("Next week's focus")).toBeVisible();
  await next();
  await expect(heading('Actions')).toBeVisible();
  await expect(page.getByText('Book the sitter for Friday')).toBeVisible();
  await page.getByRole('button', { name: 'Seal the week' }).click();

  await expect.poll(async () => (await liveRecords<{ completedAt?: string }>(page, 'reviews')).some((r) => r.completedAt)).toBe(true);
  await expect(page).toHaveURL(/#\/?$/);
  // The new action is a quick-tap item on Home.
  await expect(page.getByText('Book the sitter for Friday')).toBeVisible();
});
