// Minimal hash router (no dependency).
//   #/dashboard · #/live · #/assistant[/<conversationId>] · #/automations[/<workflowId>]
//   #/activity · #/settings[/<section>]
// Anything else falls back to #/dashboard.

import { useSyncExternalStore } from 'react';

export type Route =
  | { name: 'dashboard' }
  | { name: 'live' }
  | { name: 'assistant'; conversationId?: string }
  | { name: 'automations'; workflowId?: string }
  | { name: 'activity' }
  | { name: 'settings'; section?: string };

export type RouteName = Route['name'];

export const DEFAULT_ROUTE: Route = { name: 'dashboard' };

/** Sidebar order; Cmd+1…Cmd+6 follow it. */
export const SECTION_ORDER: readonly RouteName[] = ['dashboard', 'live', 'assistant', 'automations', 'activity', 'settings'];

function decodeSegment(segment: string | undefined): string | undefined {
  if (!segment) return undefined;
  try {
    const value = decodeURIComponent(segment).trim();
    return value.length ? value : undefined;
  } catch {
    return undefined;
  }
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '').replace(/^\/+/, '').split(/[?#]/)[0] ?? '';
  const parts = raw.split('/').filter((p) => p.length > 0);
  const [head, arg] = parts;
  switch (head) {
    case 'dashboard':
      return { name: 'dashboard' };
    case 'live':
      return { name: 'live' };
    case 'assistant': {
      const conversationId = decodeSegment(arg);
      return conversationId ? { name: 'assistant', conversationId } : { name: 'assistant' };
    }
    case 'automations': {
      const workflowId = decodeSegment(arg);
      return workflowId ? { name: 'automations', workflowId } : { name: 'automations' };
    }
    case 'activity':
      return { name: 'activity' };
    case 'settings': {
      const section = decodeSegment(arg);
      return section ? { name: 'settings', section } : { name: 'settings' };
    }
    default:
      return DEFAULT_ROUTE;
  }
}

export function routeToHash(route: Route): string {
  switch (route.name) {
    case 'assistant':
      return route.conversationId ? `#/assistant/${encodeURIComponent(route.conversationId)}` : '#/assistant';
    case 'automations':
      return route.workflowId ? `#/automations/${encodeURIComponent(route.workflowId)}` : '#/automations';
    case 'settings':
      return route.section ? `#/settings/${encodeURIComponent(route.section)}` : '#/settings';
    default:
      return `#/${route.name}`;
  }
}

/** Link target for an anchor's href. */
export function href(route: Route): string {
  return routeToHash(route);
}

export function navigate(target: Route | string, options: { replace?: boolean } = {}): void {
  const hash = typeof target === 'string' ? (target.startsWith('#') ? target : `#${target}`) : routeToHash(target);
  if (window.location.hash === hash) return;
  if (options.replace) {
    const url = `${window.location.pathname}${window.location.search}${hash}`;
    window.history.replaceState(window.history.state, '', url);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = hash;
  }
}

export function getRoute(): Route {
  return parseHash(window.location.hash);
}

let cachedHash: string | null = null;
let cachedRoute: Route = DEFAULT_ROUTE;

function snapshot(): Route {
  const hash = window.location.hash;
  if (hash !== cachedHash) {
    cachedHash = hash;
    cachedRoute = parseHash(hash);
  }
  return cachedRoute;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

/** Current route; re-renders on hash changes. */
export function useRoute(): Route {
  return useSyncExternalStore(subscribe, snapshot, () => DEFAULT_ROUTE);
}

/** Normalises an empty or unknown hash to the default route (call once at startup). */
export function ensureDefaultHash(): void {
  const parsed = parseHash(window.location.hash);
  const canonical = routeToHash(parsed);
  if (!window.location.hash || window.location.hash === '#' || window.location.hash === '#/') {
    navigate(DEFAULT_ROUTE, { replace: true });
  } else if (parsed.name === 'dashboard' && canonical !== window.location.hash) {
    navigate(DEFAULT_ROUTE, { replace: true });
  }
}
