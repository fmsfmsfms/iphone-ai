// One conversation in a single scroll area: messages merged with live
// streaming deltas, and — with `renderTask` — each AI task shown inline in the
// assistant turn it belongs to (reply text first, then the task's status,
// steps and pending approvals, so the newest thing is always at the bottom).
//
// Scrolling: the thread follows the newest content while the user is at the
// bottom. Any scroll up lets go; scrolling back down to the end follows again.
// Expanding something (steps, reasoning) also lets go and keeps the control
// that was clicked where it is, however long the content takes to load. While
// the user is away from the end a "jump to latest" button is offered.
//
// Approvals and running tasks never go missing: a newly arrived approval is
// brought into view, and while one is pending out of view (measured from the
// card's real position) the button becomes "Approval needed" and goes to it.
// While a running task's status row is out of view, a one-line strip under
// the thread keeps its status, live step and pause / cancel at hand.

import { ArrowDown, Comments, ShieldExclamation } from '@gravity-ui/icons';
import type { ChatMessage } from '@iphone-ai/shared';
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { useI18n } from '../../lib/i18n';
import { useConversationMessages, useStreamingMessages } from '../../state/store';
import { EmptyState } from '../EmptyState';
import { MessageBubble } from './MessageBubble';
import { TaskStatusBar } from './TaskCard';
import { ThreadScrollContext, type ThreadScroll } from './thread-scroll';

export interface TaskRenderContext {
  /** The task's turn has reply text (false while it has none yet). */
  hasReply: boolean;
  /** The reply text shown above the task (empty while there is none). */
  reply: string;
  /** The task is the newest one in the thread. */
  latest: boolean;
}

export interface ChatThreadProps {
  conversationId: string;
  compact?: boolean;
  /** Replaces the default empty state. */
  empty?: ReactNode;
  /** Renders the AI task of an assistant turn (shown after the reply text). */
  renderTask?: (taskId: string, context: TaskRenderContext) => ReactNode;
  /** Shown after the last message, inside the same scroll area. */
  footer?: ReactNode;
  /** An approval is pending: offer to go to it whenever it is out of view. */
  attention?: boolean;
  /** Classes for the scroll area. */
  className?: string;
  /** Horizontal padding of the content; replaces the default (`px-3` compact, `px-5` otherwise). */
  contentClassName?: string;
}

interface ThreadItem {
  message: ChatMessage;
  streaming: boolean;
}

type Entry =
  | { kind: 'message'; key: string; item: ThreadItem }
  | { kind: 'task'; key: string; taskId: string; replies: ThreadItem[]; latest: boolean };

/** Within this distance the view is at the end. */
const BOTTOM_PX = 2;
/** Scrolling down to within this distance of the end follows new content again. */
const REATTACH_PX = 24;
/** Further than this from the end offers the "jump to latest" button. */
const AWAY_PX = 48;
/** How much of a pending approval must show for it to count as seen. */
const APPROVAL_SEEN_PX = 40;
/** How much of a running task's status row must show for its controls to count as at hand. */
const TASK_SEEN_PX = 32;
/** Space kept around something the thread scrolls to. */
const REVEAL_MARGIN_PX = 12;
const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

function distanceFromBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

function scrollBehavior(): ScrollBehavior {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

function scrollToTop(el: HTMLElement, top: number, behavior: ScrollBehavior): void {
  if (typeof el.scrollTo === 'function') el.scrollTo({ top, behavior });
  else el.scrollTop = top;
}

/** Pending approval cards in the thread (ApprovalCard marks itself with the approval's id). */
function pendingApprovals(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>('[data-pending-approval]')];
}

/** Status rows of tasks that are still running (TaskCard marks them with the task's id). */
function liveTaskRows(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>('[data-live-task]')];
}

/** Whether at least `minPx` of `target` (or all of a shorter one) shows in `view`. */
function isSeen(target: HTMLElement, view: DOMRect, minPx: number): boolean {
  const r = target.getBoundingClientRect();
  const shown = Math.min(r.bottom, view.bottom) - Math.max(r.top, view.top);
  return shown >= Math.min(minPx, r.height - 1);
}

/** The scrollTop that shows all of `target` — or, when it is taller than the view, its end (an approval's decision buttons). */
function topToShow(el: HTMLElement, target: HTMLElement): number {
  const view = el.getBoundingClientRect();
  const r = target.getBoundingClientRect();
  const fits = r.height <= el.clientHeight - 2 * REVEAL_MARGIN_PX;
  if (fits && r.top >= view.top + REVEAL_MARGIN_PX && r.bottom <= view.bottom - REVEAL_MARGIN_PX) return el.scrollTop;
  const delta = fits && r.top < view.top ? r.top - view.top - REVEAL_MARGIN_PX : r.bottom - view.bottom + REVEAL_MARGIN_PX;
  return el.scrollTop + delta;
}

/** Groups each task's reply messages into one assistant turn placed right after the instruction that started it. */
function buildEntries(items: readonly ThreadItem[], groupTasks: boolean): Entry[] {
  if (!groupTasks) return items.map((item) => ({ kind: 'message', key: item.message.id, item }));
  const started = new Set<string>();
  for (const { message } of items) if (message.role === 'user' && message.taskId) started.add(message.taskId);
  const replies = new Map<string, ThreadItem[]>();
  for (const item of items) {
    const taskId = item.message.taskId;
    if (item.message.role === 'assistant' && taskId && started.has(taskId)) replies.set(taskId, [...(replies.get(taskId) ?? []), item]);
  }
  const entries: Entry[] = [];
  for (const item of items) {
    const { message } = item;
    if (message.role === 'assistant' && message.taskId && started.has(message.taskId)) continue;
    entries.push({ kind: 'message', key: message.id, item });
    if (message.role === 'user' && message.taskId) {
      entries.push({ kind: 'task', key: `task-${message.taskId}`, taskId: message.taskId, replies: replies.get(message.taskId) ?? [], latest: false });
    }
  }
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (entry.kind === 'task') {
      entry.latest = true;
      break;
    }
  }
  return entries;
}

export function ChatThread({ conversationId, compact, empty, renderTask, footer, attention, className, contentClassName }: ChatThreadProps) {
  const { t } = useI18n();
  const messages = useConversationMessages(conversationId);
  const streaming = useStreamingMessages(conversationId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const jumpRef = useRef<HTMLButtonElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  /** Following the newest content. */
  const stickRef = useRef(true);
  const lastTopRef = useRef(0);
  /** scrollTop the thread itself just set: its scroll event is not the user's. */
  const ownTopRef = useRef<number | null>(null);
  /** The control the user just expanded something with, and where it was on screen. */
  const anchorRef = useRef<{ el: HTMLElement; top: number } | null>(null);
  const attentionRef = useRef(Boolean(attention));
  attentionRef.current = Boolean(attention);
  /** Approvals already brought into view (or found in view) once. */
  const knownApprovalsRef = useRef(new Set<string>());
  const [away, setAway] = useState(false);
  const [approvalHidden, setApprovalHidden] = useState(false);
  /** The running task whose status row is out of view (its strip shows under the thread). */
  const [hiddenTaskId, setHiddenTaskId] = useState<string | null>(null);

  const items = useMemo<ThreadItem[]>(() => {
    const byId = new Map(streaming.map((s) => [s.messageId, s]));
    const list: ThreadItem[] = messages.map((message) => {
      const live = byId.get(message.id);
      if (!live) return { message, streaming: Boolean(message.streaming) };
      byId.delete(message.id);
      const text = live.text.length >= message.text.length ? live.text : message.text;
      return { message: { ...message, text }, streaming: true };
    });
    // Deltas that arrived before their chat_message announcement.
    for (const live of byId.values()) {
      list.push({
        message: {
          id: live.messageId,
          conversationId: live.conversationId,
          role: 'assistant',
          text: live.text,
          taskId: null,
          createdAt: live.updatedAt,
          streaming: true,
        },
        streaming: true,
      });
    }
    return list;
  }, [messages, streaming]);

  const entries = useMemo(() => buildEntries(items, Boolean(renderTask)), [items, renderTask]);

  const setOwnScrollTop = useCallback((el: HTMLElement, top: number) => {
    const before = el.scrollTop;
    el.scrollTop = top;
    if (Math.abs(el.scrollTop - before) >= 0.5) ownTopRef.current = el.scrollTop;
  }, []);

  /**
   * Brings an approval that just arrived into view (the user may be reading
   * further up), then updates the jump button, the "Approval needed" cue and
   * the running task's strip from where things are on screen now.
   */
  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const cards = pendingApprovals(el);
    const known = knownApprovalsRef.current;
    const fresh = cards.filter((card) => !known.has(card.dataset.pendingApproval ?? ''));
    for (const card of fresh) known.add(card.dataset.pendingApproval ?? '');
    const unseen = fresh.find((card) => !isSeen(card, el.getBoundingClientRect(), APPROVAL_SEEN_PX));
    if (unseen) {
      anchorRef.current = null;
      setOwnScrollTop(el, topToShow(el, unseen));
      stickRef.current = distanceFromBottom(el) <= BOTTOM_PX;
    }

    const view = el.getBoundingClientRect();
    const isAway = !stickRef.current && distanceFromBottom(el) > AWAY_PX;
    setAway(isAway);
    let hidden = false;
    if (attentionRef.current) {
      if (cards.length === 0) hidden = isAway;
      else hidden = !cards.some((card) => isSeen(card, view, APPROVAL_SEEN_PX));
    }
    setApprovalHidden(hidden);
    const offscreen = liveTaskRows(el).find((row) => !isSeen(row, view, TASK_SEEN_PX));
    setHiddenTaskId(offscreen?.dataset.liveTask ?? null);
  }, [setOwnScrollTop]);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = true;
    anchorRef.current = null;
    setOwnScrollTop(el, el.scrollHeight);
    measure();
  }, [measure, setOwnScrollTop]);

  // A new instruction from the user always scrolls to it.
  let lastUserId: string | null = null;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i]!.message.role === 'user') {
      lastUserId = items[i]!.message.id;
      break;
    }
  }
  const seenUserId = useRef<string | null | undefined>(undefined);
  useLayoutEffect(() => {
    if (seenUserId.current === lastUserId) return;
    seenUserId.current = lastUserId;
    scrollToBottom();
  }, [lastUserId, scrollToBottom]);

  // Anything else that changes the height (streamed text, steps, approvals,
  // images, a resized panel) keeps the view at the end while it follows, or
  // keeps the control the user just used in place.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const anchor = anchorRef.current;
      if (stickRef.current) setOwnScrollTop(el, el.scrollHeight);
      else if (anchor) {
        if (!anchor.el.isConnected) anchorRef.current = null;
        else {
          const delta = anchor.el.getBoundingClientRect().top - anchor.top;
          if (Math.abs(delta) >= 1) setOwnScrollTop(el, el.scrollTop + delta);
        }
      }
      measure();
    });
    observer.observe(content);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure, setOwnScrollTop]);

  useLayoutEffect(() => {
    measure();
  }, [attention, measure]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const own = ownTopRef.current !== null && Math.abs(top - ownTopRef.current) < 1;
    ownTopRef.current = null;
    if (!own) {
      const dist = distanceFromBottom(el);
      // Any move up lets go of the end; content that shrank under a view at the
      // end (clamping scrollTop) stays at the end and keeps following.
      if (dist <= BOTTOM_PX) stickRef.current = true;
      else if (top < lastTopRef.current - 0.5) stickRef.current = false;
      else if (dist <= REATTACH_PX) stickRef.current = true;
      anchorRef.current = null;
    }
    lastTopRef.current = top;
    measure();
  };

  /** Focus for keyboard users after the jump button goes away: the newest control in view, else the thread. */
  const focusLatest = (el: HTMLElement) => {
    const finalTop = el.scrollHeight - el.clientHeight;
    const viewTop = el.getBoundingClientRect().top;
    const last = [...(contentRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].at(-1);
    if (last && last.getBoundingClientRect().top - viewTop + el.scrollTop >= finalTop) last.focus({ preventScroll: true });
    else el.focus({ preventScroll: true });
  };

  const jump = () => {
    const el = scrollRef.current;
    if (!el) return;
    const hadFocus = jumpRef.current !== null && jumpRef.current === document.activeElement;
    const behavior = scrollBehavior();
    anchorRef.current = null;
    const card = approvalHidden ? pendingApprovals(el)[0] : undefined;
    if (card) {
      scrollToTop(el, topToShow(el, card), behavior);
      if (hadFocus) card.focus({ preventScroll: true });
      return;
    }
    stickRef.current = true;
    scrollToTop(el, el.scrollHeight, behavior);
    setAway(false);
    if (hadFocus) focusLatest(el);
  };

  /** From the strip: back to the running task's card (its status row at the top), focus included for keyboard users. */
  const revealTask = (taskId: string) => {
    const el = scrollRef.current;
    const row = el ? liveTaskRows(el).find((r) => r.dataset.liveTask === taskId) : undefined;
    if (!el || !row) return;
    const hadFocus = barRef.current?.contains(document.activeElement) ?? false;
    anchorRef.current = null;
    const top = el.scrollTop + row.getBoundingClientRect().top - el.getBoundingClientRect().top - REVEAL_MARGIN_PX;
    scrollToTop(el, Math.min(top, el.scrollHeight - el.clientHeight), scrollBehavior());
    if (hadFocus) row.closest<HTMLElement>('[tabindex="-1"]')?.focus({ preventScroll: true });
  };

  const scrollContext = useMemo<ThreadScroll>(
    () => ({
      holdPosition: (anchor) => {
        stickRef.current = false;
        anchorRef.current = anchor ? { el: anchor, top: anchor.getBoundingClientRect().top } : null;
      },
    }),
    [],
  );

  const body =
    entries.length === 0
      ? (empty ?? (
          <EmptyState
            size={compact ? 'sm' : 'md'}
            tone="ai"
            icon={<Comments />}
            title={t('chat.empty.title')}
            description={t('chat.empty.body')}
            className="my-auto"
          />
        ))
      : entries.map((entry) => {
          if (entry.kind === 'message') {
            const { message, streaming: isStreaming } = entry.item;
            return (
              <MessageBubble
                key={entry.key}
                role={message.role}
                text={message.text}
                createdAt={message.createdAt}
                streaming={isStreaming}
                compact={compact}
              />
            );
          }
          const text = entry.replies
            .map((r) => r.message.text)
            .filter((s) => s.length > 0)
            .join('\n\n');
          return (
            <MessageBubble
              key={entry.key}
              role="assistant"
              text={text}
              createdAt={entry.replies[0]?.message.createdAt ?? null}
              streaming={entry.replies.some((r) => r.streaming)}
              compact={compact}
              task={renderTask?.(entry.taskId, { hasReply: entry.replies.length > 0, reply: text, latest: entry.latest })}
            />
          );
        });

  const padX = contentClassName ?? (compact ? 'px-3' : 'px-5');

  return (
    <ThreadScrollContext.Provider value={scrollContext}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            ref={scrollRef}
            onScroll={onScroll}
            role="log"
            aria-label={t('chat.threadLabel')}
            aria-live="polite"
            tabIndex={-1}
            className={['app-scroll min-h-0 flex-1 overscroll-contain outline-none', className ?? ''].join(' ')}
          >
            <div ref={contentRef} className={['flex min-h-full flex-col', compact ? 'gap-4 py-4' : 'gap-5 py-6', padX].join(' ')}>
              {body}
              {footer}
            </div>
          </div>

          {approvalHidden || away ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
              {approvalHidden ? (
                <button
                  ref={jumpRef}
                  type="button"
                  onClick={jump}
                  className="app-transition pointer-events-auto flex items-center gap-1.5 rounded-full border border-warning/40 bg-overlay px-3 py-1.5 text-xs font-medium text-warning shadow-lg outline-none hover:bg-surface-secondary focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <ShieldExclamation className="size-3.5" />
                  {t('chat.approvalWaiting')}
                </button>
              ) : (
                <button
                  ref={jumpRef}
                  type="button"
                  onClick={jump}
                  aria-label={t('chat.jumpToLatest')}
                  title={t('chat.jumpToLatest')}
                  className="app-transition pointer-events-auto flex size-8 items-center justify-center rounded-full border border-hairline-strong bg-overlay text-foreground shadow-lg outline-none hover:bg-surface-secondary focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <ArrowDown className="size-4" />
                </button>
              )}
            </div>
          ) : null}
        </div>

        {hiddenTaskId ? (
          <div ref={barRef} className="shrink-0">
            <TaskStatusBar taskId={hiddenTaskId} compact={compact} onReveal={() => revealTask(hiddenTaskId)} className={padX} />
          </div>
        ) : null}
      </div>
    </ThreadScrollContext.Provider>
  );
}
