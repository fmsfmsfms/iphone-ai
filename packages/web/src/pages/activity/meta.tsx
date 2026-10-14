// Visual identity of activity categories and outcomes (icons + colours).

import {
  CircleCheckFill,
  CircleXmarkFill,
  Gear,
  HandPointUp,
  PersonsLock,
  PlugConnection,
  Shield,
  ShieldKeyhole,
  Sparkles,
  Thunderbolt,
  TriangleExclamation,
  TriangleExclamationFill,
  HandOk,
} from '@gravity-ui/icons';
import type { ActivityCategory, ActivityEvent } from '@iphone-ai/shared';
import type { ReactNode } from 'react';

import { eventOutcome } from './helpers';

export const CATEGORY_ICON: Record<ActivityCategory, ReactNode> = {
  manual: <HandPointUp />,
  ai: <Sparkles />,
  approval: <HandOk />,
  workflow: <Thunderbolt />,
  policy: <Shield />,
  security: <ShieldKeyhole />,
  connection: <PlugConnection />,
  session: <PersonsLock />,
  settings: <Gear />,
  error: <TriangleExclamation />,
};

/** Icon tile colours (background + foreground). */
export const CATEGORY_TONE: Record<ActivityCategory, string> = {
  manual: 'bg-accent/15 text-accent',
  ai: 'ai-gradient-bg text-white',
  approval: 'bg-warning/15 text-warning',
  workflow: 'bg-ai-purple/15 text-ai-purple',
  policy: 'bg-warning/12 text-warning',
  security: 'bg-[#64d2ff]/14 text-[#64d2ff]',
  connection: 'bg-success/12 text-success',
  session: 'bg-default text-muted',
  settings: 'bg-default text-muted',
  error: 'bg-danger/15 text-danger',
};

export function CategoryTile({ category, size = 'md' }: { category: ActivityCategory; size?: 'sm' | 'md' }) {
  return (
    <span
      aria-hidden
      className={[
        'flex shrink-0 items-center justify-center',
        size === 'sm' ? 'size-6 rounded-lg [&>svg]:size-3.5' : 'size-8 rounded-[10px] [&>svg]:size-4',
        CATEGORY_TONE[category],
      ].join(' ')}
    >
      {CATEGORY_ICON[category]}
    </span>
  );
}

export function OutcomeIcon({ event, className }: { event: ActivityEvent; className?: string }) {
  const outcome = eventOutcome(event);
  const cls = ['size-3.5 shrink-0', className ?? ''].join(' ');
  if (outcome === 'failure') return <CircleXmarkFill aria-hidden className={`${cls} text-danger`} />;
  if (outcome === 'warning') return <TriangleExclamationFill aria-hidden className={`${cls} text-warning`} />;
  if (outcome === 'success') return <CircleCheckFill aria-hidden className={`${cls} text-success`} />;
  return null;
}
