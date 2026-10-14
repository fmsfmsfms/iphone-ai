// Keyboard-shortcut hint. Keys: 'mod' (⌘ on macOS, Ctrl elsewhere), modifier
// names understood by HeroUI's Kbd ('shift', 'option', 'enter', 'escape', …)
// or literal characters ('.', 'R', '1').

import { Kbd, type KbdKey } from '@heroui/react';

import { isMac } from '../lib/hotkeys';

const KBD_KEYS = new Set<KbdKey>([
  'command',
  'shift',
  'ctrl',
  'option',
  'enter',
  'delete',
  'escape',
  'tab',
  'capslock',
  'up',
  'right',
  'down',
  'left',
  'pageup',
  'pagedown',
  'home',
  'end',
  'help',
  'space',
  'fn',
  'win',
  'alt',
]);

export type ShortcutKey = 'mod' | KbdKey | (string & {});

function resolve(key: ShortcutKey): KbdKey | string {
  if (key === 'mod') return isMac ? 'command' : 'ctrl';
  return key;
}

export interface KbdHintProps {
  keys: readonly ShortcutKey[];
  className?: string;
  /** Lighter variant for use on coloured backgrounds. */
  light?: boolean;
}

export function KbdHint({ keys, className, light }: KbdHintProps) {
  const resolved = keys.map(resolve);
  const modifiers = resolved.filter((k): k is KbdKey => KBD_KEYS.has(k as KbdKey));
  const content = resolved.filter((k) => !KBD_KEYS.has(k as KbdKey));
  return (
    <Kbd variant={light ? 'light' : 'default'} className={className} dir="ltr">
      {modifiers.map((k) => (
        <Kbd.Abbr key={k} keyValue={k} />
      ))}
      {content.length > 0 ? <Kbd.Content>{content.join('')}</Kbd.Content> : null}
    </Kbd>
  );
}

/** Plain-text rendering of a shortcut, e.g. "⌘." (for aria-keyshortcuts / titles). */
export function shortcutText(keys: readonly ShortcutKey[]): string {
  const symbols: Record<string, string> = {
    command: '⌘',
    ctrl: 'Ctrl+',
    shift: '⇧',
    option: '⌥',
    alt: 'Alt+',
    enter: '↵',
    escape: 'Esc ',
    delete: '⌫',
    tab: '⇥',
    space: 'Space',
    up: '↑',
    down: '↓',
    left: '←',
    right: '→',
  };
  return keys
    .map(resolve)
    .map((k) => symbols[k] ?? k)
    .join('')
    .trim();
}
