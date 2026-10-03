// Accessibility: axe (WCAG 2.1 A and AA rules) on every main screen. Any serious or critical problem fails.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { go, loadSampleData, openApp, skipOnboarding } from './helpers';

async function audit(page: Page, label: string) {
  // Let entrance animations (fades, even with Reduce Motion) finish first: mid-fade text reads as low contrast.
  // Endless decorative ones (glow pulses, flames) are ignored.
  // Screen fades run in JavaScript (not visible to getAnimations), so wait for the screen's own containers
  // to reach full opacity, and for browser animations too.
  await page.waitForFunction(() => {
    const top = [...document.querySelectorAll('main, main > *, main > * > *, [role="dialog"]')];
    const opaque = top.every((el) => getComputedStyle(el).opacity === '1');
    const settled = document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity);
    return opaque && settled;
  });
  await page.waitForTimeout(300);
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const bad = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const report = bad.map((v) => `${label}: [${v.impact}] ${v.id}: ${v.help}\n${v.nodes.slice(0, 5).map((n) => `   ${n.target.join(' ')} :: ${n.failureSummary?.split('\n').slice(1, 2).join(' ')}`).join('\n')}`);
  return report;
}

test('main screens have no serious accessibility problems', async ({ page }) => {
  test.setTimeout(180_000);
  await openApp(page);
  const problems: string[] = [];
  problems.push(...(await audit(page, 'onboarding')));
  await skipOnboarding(page);
  await loadSampleData(page);
  await page.waitForFunction(() => !!document.querySelector('main'));

  const screens: [string, string][] = [
    ['home', '#/'],
    ['burner', '#/burner/family'],
    ['settings', '#/settings'],
    ['review', '#/review'],
    ['check-in', '#/checkin'],
    ['about', '#/about'],
    ['coach history', '#/coach'],
    ['archive', '#/archive'],
  ];
  for (const [label, hash] of screens) {
    await go(page, hash);
    await page.waitForTimeout(400);
    problems.push(...(await audit(page, label)));
  }

  await go(page, '#/');
  await page.getByRole('button', { name: /^\+\s*Log$/ }).click();
  await expect(page.getByRole('dialog', { name: 'Log progress' })).toBeVisible();
  problems.push(...(await audit(page, 'log sheet')));

  expect(problems, problems.join('\n\n')).toEqual([]);
});
