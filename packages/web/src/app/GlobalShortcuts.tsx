// App-wide shortcuts: Cmd+1…6 sections, Cmd+. STOP, Esc twice (within 800 ms)
// STOP, ? opens the shortcut reference.

import { useRef } from 'react';

import { createDoublePressDetector, hasMod, isTypingTarget, useWindowKeydown } from '../lib/hotkeys';
import { navigate, SECTION_ORDER } from '../lib/router';
import { appStore, engageStop } from '../state/store';
import { t } from '../lib/i18n';

export const ESC_DOUBLE_PRESS_MS = 800;

export function GlobalShortcuts({ onShowShortcuts }: { onShowShortcuts: () => void }) {
  const escape = useRef(createDoublePressDetector(ESC_DOUBLE_PRESS_MS));

  const stop = () => {
    if (appStore.getState().stop.latched) return;
    engageStop(t('stop.reasonShortcut')).catch(() => undefined);
  };

  useWindowKeydown(
    (e) => {
      // Emergency stop first; it must work everywhere, including text fields and dialogs.
      if (hasMod(e) && (e.key === '.' || e.code === 'Period')) {
        e.preventDefault();
        stop();
        return;
      }
      if (e.key === 'Escape' && !e.repeat) {
        if (escape.current.press()) stop();
        return;
      }
      escape.current.reset();

      const digit = /^Digit([1-6])$/.exec(e.code)?.[1] ?? (/^[1-6]$/.test(e.key) ? e.key : null);
      if (hasMod(e) && !e.shiftKey && !e.altKey && digit) {
        const name = SECTION_ORDER[Number(digit) - 1];
        if (name) {
          e.preventDefault();
          navigate({ name });
        }
        return;
      }

      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey && !isTypingTarget(e.target)) {
        e.preventDefault();
        onShowShortcuts();
      }
    },
    { capture: true },
  );

  return null;
}
