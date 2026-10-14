// Two-column label/value list for diagnostics and details.

import type { ReactNode } from 'react';

export interface KeyValueItem {
  label: ReactNode;
  value: ReactNode;
  /** Monospace value (paths, ids, versions). */
  mono?: boolean;
  hint?: ReactNode;
  key?: string;
}

export interface KeyValueListProps {
  items: KeyValueItem[];
  className?: string;
  dense?: boolean;
}

export function KeyValueList({ items, className, dense }: KeyValueListProps) {
  return (
    <dl className={['grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4', dense ? 'gap-y-1.5' : 'gap-y-2.5', className ?? ''].join(' ')}>
      {items.map((item, i) => (
        <div key={item.key ?? i} className="contents">
          <dt className="text-[13px] leading-5 text-muted">{item.label}</dt>
          <dd className="min-w-0 text-[13px] leading-5 text-foreground">
            <span className={item.mono ? 'font-mono text-[12px] break-all' : 'break-words'}>{item.value}</span>
            {item.hint ? <span className="block text-xs text-muted">{item.hint}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}
