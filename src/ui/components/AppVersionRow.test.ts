// AppVersionRow, rendered to static markup: the helper line is readable and the live region that
// announces "Checking..." / "Up to date" stays mounted while its content swaps.
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppVersionRow } from './AppVersionRow';

describe('AppVersionRow', () => {
  const html = renderToString(createElement(AppVersionRow));

  it('shows the update note in readable text, not the faint style', () => {
    const note = html.match(/<div class="([^"]*)">Updates install on their own\.<\/div>/);
    expect(note).not.toBeNull();
    expect(note![1]).toContain('text-dim');
    expect(note![1]).not.toContain('text-faint');
  });

  it('announces from one stable live region, not from the animated element keyed by the view', () => {
    const regions: string[] = html.match(/<[a-z]+[^>]*aria-live="polite"[^>]*>/g) ?? [];
    expect(regions).toHaveLength(1);
    // The keyed element is a motion element with inline animation styles; the live region must not be it.
    expect(regions[0]).not.toContain('style=');
    expect(html.indexOf('Check for updates')).toBeGreaterThan(html.indexOf(regions[0]));
  });
});
