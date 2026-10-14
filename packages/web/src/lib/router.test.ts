import { describe, expect, it } from 'vitest';

import { parseHash, routeToHash, type Route } from './router';

describe('parseHash', () => {
  it('parses every section', () => {
    expect(parseHash('#/dashboard')).toEqual({ name: 'dashboard' });
    expect(parseHash('#/live')).toEqual({ name: 'live' });
    expect(parseHash('#/assistant')).toEqual({ name: 'assistant' });
    expect(parseHash('#/assistant/conv_123')).toEqual({ name: 'assistant', conversationId: 'conv_123' });
    expect(parseHash('#/automations')).toEqual({ name: 'automations' });
    expect(parseHash('#/automations/wf%201')).toEqual({ name: 'automations', workflowId: 'wf 1' });
    expect(parseHash('#/activity')).toEqual({ name: 'activity' });
    expect(parseHash('#/settings')).toEqual({ name: 'settings' });
    expect(parseHash('#/settings/ai')).toEqual({ name: 'settings', section: 'ai' });
  });

  it('defaults to the dashboard', () => {
    expect(parseHash('')).toEqual({ name: 'dashboard' });
    expect(parseHash('#')).toEqual({ name: 'dashboard' });
    expect(parseHash('#/nope')).toEqual({ name: 'dashboard' });
  });

  it('tolerates trailing slashes, query strings and bad encodings', () => {
    expect(parseHash('#/live/')).toEqual({ name: 'live' });
    expect(parseHash('#/settings/remote?x=1')).toEqual({ name: 'settings', section: 'remote' });
    expect(parseHash('#/assistant/%E0%A4%A')).toEqual({ name: 'assistant' });
  });
});

describe('routeToHash', () => {
  it('round-trips', () => {
    const routes: Route[] = [
      { name: 'dashboard' },
      { name: 'live' },
      { name: 'assistant' },
      { name: 'assistant', conversationId: 'a/b' },
      { name: 'automations', workflowId: 'wf_1' },
      { name: 'activity' },
      { name: 'settings', section: 'permissions' },
    ];
    for (const route of routes) expect(parseHash(routeToHash(route))).toEqual(route);
  });
});
