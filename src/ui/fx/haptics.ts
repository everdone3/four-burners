// Haptic taps. iOS Safari has no Vibration API, but toggling a native switch control
// (Safari 18+) plays the system haptic, so we keep a hidden one and click it.

let enabled = true;
let label: HTMLLabelElement | null = null;

export function setHapticsEnabled(on: boolean) {
  enabled = on;
}

function ensureSwitch(): HTMLLabelElement {
  if (label) return label;
  label = document.createElement('label');
  label.setAttribute('aria-hidden', 'true');
  label.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('switch', '');
  input.tabIndex = -1;
  label.appendChild(input);
  document.body.appendChild(label);
  return label;
}

/** Call only from a user gesture (tap handler). */
export function haptic(pattern: 'light' | 'success' = 'light') {
  if (!enabled) return;
  if (navigator.vibrate) {
    navigator.vibrate(pattern === 'success' ? [12, 60, 24] : 10);
    return;
  }
  const l = ensureSwitch();
  l.click();
  if (pattern === 'success') setTimeout(() => l.click(), 90);
}
