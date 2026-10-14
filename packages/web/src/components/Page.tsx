// Standard page frame: title row (with optional actions) and a scrollable body.
// Pages render inside the shell's <main>, which does not scroll by itself.

import type { ReactNode } from 'react';

export interface PageProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** `false` gives the body a fixed height (for split layouts that scroll internally). */
  scroll?: boolean;
  /** Max content width. */
  width?: 'narrow' | 'default' | 'wide' | 'full';
  className?: string;
  bodyClassName?: string;
}

const WIDTH: Record<NonNullable<PageProps['width']>, string> = {
  narrow: 'max-w-3xl',
  default: 'max-w-5xl',
  wide: 'max-w-7xl',
  full: 'max-w-none',
};

export function Page({ title, description, icon, actions, children, scroll = true, width = 'wide', className, bodyClassName }: PageProps) {
  return (
    <div className={['flex h-full min-h-0 flex-col', className ?? ''].join(' ')}>
      <div className={scroll ? 'app-scroll min-h-0 flex-1' : 'flex min-h-0 flex-1 flex-col'}>
        <div className={['mx-auto flex w-full flex-col', WIDTH[width], scroll ? '' : 'min-h-0 flex-1'].join(' ')}>
          <header className="flex flex-wrap items-start gap-4 px-6 pt-6 pb-5">
            {icon ? (
              <span aria-hidden className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-2xl bg-default text-foreground [&>svg]:size-5">
                {icon}
              </span>
            ) : null}
            <div className="min-w-0 flex-1">
              <h1 className="text-[22px] leading-8 font-semibold tracking-tight text-foreground">{title}</h1>
              {description ? <p className="mt-0.5 text-[13px] leading-5 text-muted">{description}</p> : null}
            </div>
            {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
          </header>
          <div className={['px-6', scroll ? 'pb-10' : 'flex min-h-0 flex-1 flex-col pb-6', bodyClassName ?? ''].join(' ')}>{children}</div>
        </div>
      </div>
    </div>
  );
}
