// BackupPanel, rendered to static markup: the helper line under the buttons is readable on the dark card.
import 'fake-indexeddb/auto';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BackupPanel } from './BackupPanel';

describe('BackupPanel', () => {
  it('shows what a backup is in readable text, not the faint style', () => {
    const html = renderToString(createElement(BackupPanel));
    const line = html.match(/<p class="([^"]*)">A backup is a safety copy you keep in Files\. It is separate from sync\.<\/p>/);
    expect(line).not.toBeNull();
    expect(line![1]).toContain('text-dim');
    expect(line![1]).not.toContain('text-faint');
  });
});
