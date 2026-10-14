import { describe, expect, it } from 'vitest';

import { createDoublePressDetector } from './hotkeys';
import { backoffDelay, parseServerEvent, wsUrl } from './ws';

describe('parseServerEvent', () => {
  it('accepts known event types', () => {
    expect(parseServerEvent(JSON.stringify({ type: 'stop_released', at: 1 }))).toEqual({ type: 'stop_released', at: 1 });
  });

  it('rejects malformed or unknown messages', () => {
    expect(parseServerEvent('not json')).toBeNull();
    expect(parseServerEvent(JSON.stringify({ type: 'mystery' }))).toBeNull();
    expect(parseServerEvent(JSON.stringify(['frame']))).toBeNull();
    expect(parseServerEvent(42)).toBeNull();
  });
});

describe('backoffDelay', () => {
  it('grows exponentially and is capped', () => {
    const none = () => 0;
    expect(backoffDelay(0, none)).toBe(500);
    expect(backoffDelay(1, none)).toBe(1000);
    expect(backoffDelay(3, none)).toBe(4000);
    expect(backoffDelay(20, none)).toBe(15000);
    expect(backoffDelay(20, () => 1)).toBe(15000);
    expect(backoffDelay(0, () => 1)).toBe(600);
  });
});

describe('wsUrl', () => {
  it('uses the page origin', () => {
    expect(wsUrl({ protocol: 'http:', host: '127.0.0.1:47823' })).toBe('ws://127.0.0.1:47823/ws');
    expect(wsUrl({ protocol: 'https:', host: 'mac.tailnet:47824' })).toBe('wss://mac.tailnet:47824/ws');
  });
});

describe('double Esc detection', () => {
  it('fires on the second press within the window only', () => {
    let now = 0;
    const detector = createDoublePressDetector(800, () => now);
    expect(detector.press()).toBe(false);
    now = 500;
    expect(detector.press()).toBe(true);
    now = 700;
    expect(detector.press()).toBe(false);
    now = 1600;
    expect(detector.press()).toBe(false);
    now = 1700;
    expect(detector.press()).toBe(true);
  });
});
