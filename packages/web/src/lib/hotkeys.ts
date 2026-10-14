// Keyboard helpers: platform-aware "mod" key, typing-target detection and a
// small hook for window-level shortcuts.

import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';

export const isMac: boolean =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '');

/** Cmd on macOS, Ctrl elsewhere. */
export function hasMod(e: KeyboardEvent | ReactKeyboardEvent): boolean {
  return isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

export function hasNoModifiers(e: KeyboardEvent | ReactKeyboardEvent): boolean {
  return !e.metaKey && !e.ctrlKey && !e.altKey;
}

/** True when the event target accepts text (shortcuts without modifiers must not fire there). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type);
  }
  return target.getAttribute('role') === 'textbox';
}

/** Registers a window keydown handler for the component's lifetime (handler may change freely). */
export function useWindowKeydown(handler: (e: KeyboardEvent) => void, options: { capture?: boolean; enabled?: boolean } = {}): void {
  const ref = useRef(handler);
  ref.current = handler;
  const { capture = false, enabled = true } = options;
  useEffect(() => {
    if (!enabled) return;
    const listener = (e: KeyboardEvent) => ref.current(e);
    window.addEventListener('keydown', listener, { capture });
    return () => window.removeEventListener('keydown', listener, { capture });
  }, [capture, enabled]);
}

/** Detects two presses of the same key within `windowMs`. */
export function createDoublePressDetector(windowMs: number, now: () => number = () => performance.now()) {
  let last = -Infinity;
  return {
    press(): boolean {
      const t = now();
      const isDouble = t - last <= windowMs;
      last = isDouble ? -Infinity : t;
      return isDouble;
    },
    reset(): void {
      last = -Infinity;
    },
  };
}
