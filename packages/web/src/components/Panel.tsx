// Card containers. `Panel` is the standard rounded card with a header row
// (icon, title, description, actions); `Section` is a lighter titled group
// used inside panels and side columns.

import { Card } from '@heroui/react';
import type { ReactNode } from 'react';

export interface PanelProps {
  title?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
  bodyClassName?: string;
  /** Visually highlight AI-related panels with a subtle blue→purple ring. */
  tone?: 'default' | 'ai' | 'warning' | 'danger';
  id?: string;
}

const TONE_CLASS: Record<NonNullable<PanelProps['tone']>, string> = {
  default: '',
  ai: 'ai-ring',
  warning: 'border-warning/30',
  danger: 'border-danger/35',
};

export function Panel({ title, description, icon, actions, children, footer, className, bodyClassName, tone = 'default', id }: PanelProps) {
  const hasHeader = Boolean(title || description || actions || icon);
  return (
    <Card
      id={id}
      className={['app-panel gap-0 overflow-hidden p-0 shadow-none', TONE_CLASS[tone], className ?? ''].join(' ')}
    >
      {hasHeader ? (
        <Card.Header className="flex flex-row items-start gap-3 px-5 pt-4 pb-3">
          {icon ? (
            <span
              aria-hidden
              className={[
                'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl [&>svg]:size-4',
                tone === 'ai' ? 'ai-gradient-bg text-white' : 'bg-default text-muted',
              ].join(' ')}
            >
              {icon}
            </span>
          ) : null}
          <div className="min-w-0 flex-1">
            {title ? <Card.Title className="text-[15px] leading-6 font-semibold text-foreground">{title}</Card.Title> : null}
            {description ? (
              <Card.Description className="mt-0.5 text-[13px] leading-5 text-muted">{description}</Card.Description>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
        </Card.Header>
      ) : null}
      <Card.Content className={['px-5 pb-5', hasHeader ? 'pt-0' : 'pt-5', bodyClassName ?? ''].join(' ')}>{children}</Card.Content>
      {footer ? <Card.Footer className="border-t border-hairline px-5 py-3">{footer}</Card.Footer> : null}
    </Card>
  );
}

export interface SectionProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function Section({ title, description, actions, children, className }: SectionProps) {
  return (
    <section className={['flex flex-col gap-2.5', className ?? ''].join(' ')}>
      <header className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">{title}</h3>
          {description ? <p className="mt-0.5 text-xs leading-5 text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}
