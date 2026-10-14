// Friendly empty / error state with an icon, title, explanation and next steps.

import type { ReactNode } from 'react';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Buttons for the next step. */
  actions?: ReactNode;
  tone?: 'default' | 'warning' | 'danger' | 'ai';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  children?: ReactNode;
}

const ICON_TONE: Record<NonNullable<EmptyStateProps['tone']>, string> = {
  default: 'bg-default text-muted',
  warning: 'bg-warning/12 text-warning',
  danger: 'bg-danger/12 text-danger',
  ai: 'ai-gradient-bg text-white',
};

const SIZE: Record<NonNullable<EmptyStateProps['size']>, { wrap: string; icon: string; title: string; text: string }> = {
  sm: { wrap: 'gap-2 py-5', icon: 'size-9 rounded-xl [&>svg]:size-4', title: 'text-sm', text: 'text-xs' },
  md: { wrap: 'gap-3 py-8', icon: 'size-11 rounded-2xl [&>svg]:size-5', title: 'text-[15px]', text: 'text-[13px]' },
  lg: { wrap: 'gap-4 py-12', icon: 'size-14 rounded-2xl [&>svg]:size-6', title: 'text-lg', text: 'text-sm' },
};

export function EmptyState({ icon, title, description, actions, tone = 'default', size = 'md', className, children }: EmptyStateProps) {
  const s = SIZE[size];
  return (
    <div role="status" className={['flex flex-col items-center px-4 text-center', s.wrap, className ?? ''].join(' ')}>
      {icon ? (
        <span aria-hidden className={['flex items-center justify-center', s.icon, ICON_TONE[tone]].join(' ')}>
          {icon}
        </span>
      ) : null}
      <div className="flex max-w-md flex-col gap-1">
        <p className={['font-semibold text-foreground', s.title].join(' ')}>{title}</p>
        {description ? <div className={['leading-relaxed text-muted', s.text].join(' ')}>{description}</div> : null}
      </div>
      {children}
      {actions ? <div className="flex flex-wrap items-center justify-center gap-2">{actions}</div> : null}
    </div>
  );
}
