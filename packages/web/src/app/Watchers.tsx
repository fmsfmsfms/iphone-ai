// Invisible components that react to store changes: toasts, approval
// notifications, the focus-steal notice and the theme.

import { toast } from '@heroui/react';
import type { ApprovalRequest } from '@iphone-ai/shared';
import { useEffect, useRef } from 'react';

import { useI18n } from '../lib/i18n';
import { navigate, useRoute, type Route } from '../lib/router';
import { appStore, setUi, useAppStore, type StoreState, type ToastItem } from '../state/store';

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

/**
 * Whether the page at `route` actually shows a card for this approval:
 * Live Control lists every pending approval (in its assistant pane); the AI Assistant shows only the
 * selected conversation's tasks; a workflow page only that workflow's runs.
 * Unknown task or run → false, so the toast is shown (the safe default).
 */
export function approvalCardVisible(approval: ApprovalRequest, route: Route, state: StoreState = appStore.getState()): boolean {
  switch (route.name) {
    case 'live':
      // The assistant pane lists every pending approval, unless the user collapsed it.
      return !state.ui.liveAssistantCollapsed;
    case 'assistant':
      return Boolean(
        approval.workflowRunId === null &&
          approval.taskId &&
          route.conversationId &&
          state.tasks[approval.taskId]?.conversationId === route.conversationId,
      );
    case 'automations':
      return Boolean(
        approval.workflowRunId && route.workflowId && state.workflowRuns[approval.workflowRunId]?.workflowId === route.workflowId,
      );
    default:
      return false;
  }
}

/** Where "Review" goes: a page that renders this approval's card (Live Control lists them all). */
export function approvalReviewTarget(approval: ApprovalRequest, state: StoreState = appStore.getState()): Route {
  if (approval.workflowRunId) {
    const workflowId = state.workflowRuns[approval.workflowRunId]?.workflowId;
    return workflowId ? { name: 'automations', workflowId } : { name: 'live' };
  }
  const conversationId = approval.taskId ? state.tasks[approval.taskId]?.conversationId : undefined;
  return conversationId ? { name: 'assistant', conversationId } : { name: 'live' };
}

/** Announces new approval requests unless a card for that request is already on screen. */
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
      if (approvalCardVisible(approval, route)) continue;
      const target = approvalReviewTarget(approval);
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
  }, [approvals, route, t]);
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
