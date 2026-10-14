// Loads the activity history for the current filters (GET /api/activity),
// pages backwards with `before`, and merges live `activity` WebSocket events
// that arrived after the list was fetched.

import type { ActivityEvent } from '@iphone-ai/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, errorMessage } from '../../lib/api';
import { appStore, useConnection, useLiveActivity } from '../../state/store';
import { filtersToQuery, freshLiveEvents, mergeEvents, nextPageCursor, PAGE_SIZE, type ActivityFilters } from './helpers';

export type FeedStatus = 'loading' | 'ready' | 'error';

interface FeedState {
  status: FeedStatus;
  /** Events fetched from the API (all pages), newest first. */
  loaded: ActivityEvent[];
  hasMore: boolean;
  loadingMore: boolean;
  error: string | null;
  loadMoreError: string | null;
  /** Live event ids already in the store when the list was fetched. */
  baseline: ReadonlySet<string>;
  /** Filters the loaded list belongs to (serialized query). */
  key: string | null;
}

const INITIAL: FeedState = {
  status: 'loading',
  loaded: [],
  hasMore: false,
  loadingMore: false,
  error: null,
  loadMoreError: null,
  baseline: new Set(),
  key: null,
};

export interface ActivityFeed {
  status: FeedStatus;
  /** Loaded + live events matching the filters, newest first. */
  events: ActivityEvent[];
  hasMore: boolean;
  loadingMore: boolean;
  error: string | null;
  loadMoreError: string | null;
  /** True while a reload for new filters is running and older results are still shown. */
  refreshing: boolean;
  reload: () => Promise<void>;
  loadMore: () => Promise<void>;
}

export function useActivityFeed(filters: ActivityFilters): ActivityFeed {
  const [state, setState] = useState<FeedState>(INITIAL);
  const requestId = useRef(0);
  const live = useLiveActivity();
  const connection = useConnection();

  const query = useMemo(() => filtersToQuery(filters), [filters]);
  const key = useMemo(() => JSON.stringify(query), [query]);
  const queryRef = useRef(query);
  queryRef.current = query;

  const reload = useCallback(async () => {
    const id = ++requestId.current;
    const currentKey = key;
    // Everything already received live is covered by this fetch.
    const baseline = new Set(appStore.getState().activity.map((e) => e.id));
    setState((s) => ({ ...s, status: s.key === currentKey && s.status === 'ready' ? 'ready' : 'loading', error: null }));
    try {
      const page = await api.activity.list({ ...queryRef.current, limit: PAGE_SIZE });
      if (id !== requestId.current) return;
      setState({
        status: 'ready',
        loaded: mergeEvents(page),
        hasMore: page.length >= PAGE_SIZE,
        loadingMore: false,
        error: null,
        loadMoreError: null,
        baseline,
        key: currentKey,
      });
    } catch (err) {
      if (id !== requestId.current) return;
      setState((s) => ({ ...s, status: 'error', error: errorMessage(err), loadingMore: false }));
    }
  }, [key]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Events recorded while the socket was down never arrive live: refetch after a reconnect.
  const wasOpen = useRef(connection.socket === 'open');
  useEffect(() => {
    const open = connection.socket === 'open';
    if (open && !wasOpen.current) void reload();
    wasOpen.current = open;
  }, [connection.socket, reload]);

  const loadMore = useCallback(async () => {
    const snapshot = state;
    if (snapshot.loadingMore || !snapshot.hasMore || snapshot.status !== 'ready') return;
    const id = requestId.current;
    setState((s) => ({ ...s, loadingMore: true, loadMoreError: null }));
    try {
      let cursor = nextPageCursor(snapshot.loaded);
      let page = cursor === null ? [] : await api.activity.list({ ...queryRef.current, limit: PAGE_SIZE, before: cursor });
      let merged = mergeEvents(snapshot.loaded, page);
      if (merged.length === snapshot.loaded.length && page.length >= PAGE_SIZE) {
        // A full page of events sharing the oldest millisecond: step past it.
        cursor = nextPageCursor(snapshot.loaded, true);
        page = cursor === null ? [] : await api.activity.list({ ...queryRef.current, limit: PAGE_SIZE, before: cursor });
        merged = mergeEvents(snapshot.loaded, page);
      }
      if (id !== requestId.current) return;
      setState((s) => ({ ...s, loaded: merged, hasMore: page.length >= PAGE_SIZE, loadingMore: false }));
    } catch (err) {
      if (id !== requestId.current) return;
      setState((s) => ({ ...s, loadingMore: false, loadMoreError: errorMessage(err) }));
    }
  }, [state]);

  const events = useMemo(
    () => (state.status === 'error' && state.loaded.length === 0 ? [] : mergeEvents(freshLiveEvents(live, state.baseline, filters), state.loaded)),
    [live, state.baseline, state.loaded, state.status, filters],
  );

  return {
    status: state.status,
    events,
    hasMore: state.hasMore,
    loadingMore: state.loadingMore,
    error: state.error,
    loadMoreError: state.loadMoreError,
    refreshing: state.status === 'loading' && state.loaded.length > 0,
    reload,
    loadMore,
  };
}
