// RelativeTime must keep ticking while `at` keeps moving: the live viewer
// passes each frame's load time (about twice a second) and used to read
// "updated in 2 min" because its clock froze.

import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatRelative, RelativeTime } from './RelativeTime';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-14T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

const text = () => screen.getByRole('time').textContent ?? '';

describe('RelativeTime', () => {
  it('never shows a future time while `at` advances faster than its tick', () => {
    const { rerender } = render(<RelativeTime at={Date.now()} />);
    // Frames every 500 ms for two minutes.
    for (let i = 0; i < 240; i += 1) {
      act(() => {
        vi.advanceTimersByTime(500);
      });
      rerender(<RelativeTime at={Date.now()} />);
      expect(text()).not.toMatch(/^in /);
    }
    expect(text()).toBe('now');
  });

  it('keeps counting once `at` stops changing', () => {
    const at = Date.now();
    render(<RelativeTime at={at} />);
    expect(text()).toBe('now');
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(text()).toBe('10 sec. ago');
    act(() => {
      vi.advanceTimersByTime(3 * 60_000);
    });
    expect(text()).toBe(formatRelative(at, Date.now(), 'en-US'));
    expect(text()).toMatch(/min\. ago$/);
  });

  it('shows the fallback without a time', () => {
    render(<RelativeTime at={null} fallback="Never" />);
    expect(screen.getByText('Never')).toBeInTheDocument();
  });
});
