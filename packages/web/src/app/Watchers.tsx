// Invisible components that react to store changes: toasts, approval
// notifications, the focus-steal notice and the theme.

import { toast } from '@heroui/react';
import { useEffect, useRef } from 'react';

import { useI18n } from '../lib/i18n';
import { navigate, useRoute } from '../lib/router';
import { appStore, setUi, useAppStore, type ToastItem } from '../state/store';

const VARIANT: Record<ToastItem['level'], 'default' | 'accent' | 'success' | 'warning' | 'danger'> = {
  info: 'accent',
  success: 'success',
  warning: 'warning',
  error: 'danger',
};

/** Shows store toasts (server `toast` events and UI notifications) with HeroUI's toast queue. */
export function ToastBridge() {
  const lastShown = useRef<number>(appStore.getState().toasts.at(-1)?.id ?? 0);
  const toasts = useAppStore((s) => s.toasts);
  useEffect(() => {
    for (const item of toasts) {
      if (item.id <= lastShown.current) continue;
      lastShown.current = item.id;
      toast(item.title, {
        description: item.message,
        variant: VARIANT[item.level],
        timeout: item.level === 'error' ? 8000 : item.level === 'warning' ? 6000 : 4000,
      });
    }
  }, [toasts]);
  return null;
}

/** Tells the user (once per session, as a toast) that input moved macOS focus to iPhone Mirroring. */
export function FocusStealWatcher() {
  const { t } = useI18n();
  const lastFocusSteal = useAppStore((s) => s.status?.lastFocusSteal ?? null);
  const shown = useAppStore((s) => s.ui.focusStealToastShown);
  const initial = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (initial.current === undefined) {
      // Ignore whatever happened before this page loaded.
      initial.current = lastFocusSteal;
      return;
    }
    if (!lastFocusSteal || lastFocusSteal === initial.current) return;
    if (!shown) {
      toast(t('viewer.focus.title'), { description: t('viewer.focus.body'), variant: 'default', timeout: 7000 });
      setUi({ focusStealToastShown: true, focusStealAcknowledgedAt: lastFocusSteal });
    }
  }, [lastFocusSteal, shown, t]);
  return null;
}

/** Announces new approval requests when the user is not looking at an approvals view. */
export function ApprovalWatcher() {
  const { t } = useI18n();
  const route = useRoute();
  const approvals = useAppStore((s) => s.approvals);
  const seen = useRef<Set<string> | null>(null);
  const open = useRef(new Map<string, string>());
  useEffect(() => {
    // Close notifications for approvals that were decided, expired or cancelled.
    const pendingIds = new Set(approvals.map((a) => a.id));
    for (const [approvalId, toastId] of open.current) {
      if (!pendingIds.has(approvalId)) {
        toast.close(toastId);
        open.current.delete(approvalId);
      }
    }
    if (seen.current === null) {
      seen.current = new Set(approvals.map((a) => a.id));
      return;
    }
    for (const approval of approvals) {
      if (seen.current.has(approval.id)) continue;
      seen.current.add(approval.id);
      const onApprovalsView = route.name === 'live' || route.name === 'assistant' || (approval.workflowRunId !== null && route.name === 'automations');
      if (onApprovalsView) continue;
      const target = approval.workflowRunId ? ({ name: 'automations' } as const) : ({ name: 'live' } as const);
      const id = toast(t('approval.toast.title'), {
        description: approval.summary,
        variant: 'warning',
        timeout: 0,
        actionProps: {
          children: t('approval.toast.review'),
          onPress: () => {
            navigate(target);
            toast.close(id);
          },
        },
        onClose: () => open.current.delete(approval.id),
      });
      open.current.set(approval.id, id);
    }
  }, [approvals, route.name, t]);
  return null;
}

/** Applies settings.general.theme (dark / light / system) to <html>. */
export function ThemeController() {
  const theme = useAppStore((s) => s.settings?.general.theme ?? 'dark');
  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const apply = () => {
      const resolved = theme === 'system' ? (media?.matches ? 'dark' : 'light') : theme;
      root.classList.toggle('dark', resolved === 'dark');
      root.classList.toggle('light', resolved === 'light');
      root.dataset['theme'] = resolved;
      root.style.colorScheme = resolved;
    };
    apply();
    if (theme !== 'system' || !media) return;
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  return null;
}
