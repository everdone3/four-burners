// The single coach interface. Today there is one implementation: copy the packet, the user opens the
// Claude app and pastes, then pastes the reply back here. A direct API mode could implement this same
// interface later without touching any screen. (Not built: the app makes no AI API calls.)
//
// iOS notes (see docs/coach-design.md, "iOS hand-off research"):
// - Clipboard writes need a user gesture, so writeText is the first call in the tap, with the packet
//   built before the tap.
// - Copying and opening Claude are two taps: navigating after an awaited copy would no longer count
//   as a user tap, and universal links would be ignored.
// - https://claude.ai/new is a universal link into the Claude app (listed in claude.ai's
//   apple-app-site-association). claude://claude.ai/new is a backup that shows an iOS "Open?" prompt.
// - No text ever travels in a URL: chat prefill on mobile is undocumented, and URLs end up in logs.
import type { BuiltPacket } from '@/domain/coach/packets';

export type DeliveryResult = { mode: 'copy-paste'; copied: true } | { mode: 'copy-paste'; copied: false; reason: string };

export interface CoachChannel {
  readonly mode: 'copy-paste';
  /** Send a packet to the coach. For copy-paste this copies it; the user opens Claude with a second tap. */
  deliver(packet: BuiltPacket): Promise<DeliveryResult>;
}

/** Universal link into the Claude app. Must be a real <a> the user taps, with no query or fragment. */
export const CLAUDE_UNIVERSAL_LINK = 'https://claude.ai/new';
/** Backup: custom scheme (iOS asks "Open in Claude?"). Only on an explicit tap. */
export const CLAUDE_SCHEME_LINK = 'claude://claude.ai/new';

/**
 * Copy text. Call synchronously at the start of a tap handler: the first statement touches the
 * clipboard before anything is awaited. Falls back to a hidden textarea and execCommand.
 */
export function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    // Start the write inside the gesture; resolve with the outcome.
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => legacyCopy(text),
    );
  }
  return Promise.resolve(legacyCopy(text));
}

function legacyCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = `position:absolute;left:-9999px;top:${window.pageYOffset}px;font-size:16px;border:0;padding:0;margin:0`;
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export const copyPasteCoach: CoachChannel = {
  mode: 'copy-paste',
  async deliver(packet) {
    const copied = await copyText(packet.text);
    return copied
      ? { mode: 'copy-paste', copied: true }
      : { mode: 'copy-paste', copied: false, reason: 'Copy was blocked. Press and hold the text below, then tap Copy.' };
  },
};

/** The coach the app uses. Swap this for an API channel later. */
export const coach: CoachChannel = copyPasteCoach;
