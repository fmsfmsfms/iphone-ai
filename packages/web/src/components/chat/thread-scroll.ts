// Lets content inside a ChatThread tell it that the next change in height is
// the user's own doing (expanding a task's steps, opening reasoning): the
// thread then stops following the newest content and keeps the control the
// user clicked where it is, however long what it opens takes to load.

import { createContext, useContext } from 'react';

export interface ThreadScroll {
  /** Call right before a user-initiated expand / collapse, with the control that was used. */
  holdPosition: (anchor?: HTMLElement | null) => void;
}

export const ThreadScrollContext = createContext<ThreadScroll | null>(null);

const noop = () => undefined;

export function useHoldScrollPosition(): (anchor?: HTMLElement | null) => void {
  return useContext(ThreadScrollContext)?.holdPosition ?? noop;
}
