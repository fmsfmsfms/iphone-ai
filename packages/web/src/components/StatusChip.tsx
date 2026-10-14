// Compact status pill: coloured dot + label (+ optional icon and tooltip).

import { Chip, Tooltip } from '@heroui/react';
import type { ReactNode } from 'react';

import type { Tone } from '../lib/device-state';

export type { Tone } from '../lib/device-state';

const CHIP_COLOR: Record<Tone, 'default' | 'accent' | 'success' | 'warning' | 'danger'> = {
  default: 'default',
  accent: 'accent',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  ai: 'accent',
};

export interface StatusChipProps {
  tone: Tone;
  label: ReactNode;
  icon?: ReactNode;
  /** Shows a pulsing dot (in-progress states). */
  pulse?: boolean;
  /** Hide the dot (e.g. when an icon conveys the state). */
  hideDot?: boolean;
  tooltip?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export function StatusChip({ tone, label, icon, pulse, hideDot, tooltip, size = 'md', className }: StatusChipProps) {
  const chip = (
    <Chip
      color={CHIP_COLOR[tone]}
      variant="soft"
      size={size}
      className={['gap-1.5 whitespace-nowrap', tone === 'ai' ? 'chip--ai' : '', className ?? ''].join(' ').trim()}
    >
      {!hideDot && <span aria-hidden className={`status-dot ${pulse ? 'status-dot--pulse' : ''}`} />}
      {icon ? (
        <span aria-hidden className="flex size-3.5 items-center justify-center [&>svg]:size-3.5">
          {icon}
        </span>
      ) : null}
      <Chip.Label>{label}</Chip.Label>
    </Chip>
  );
  if (!tooltip) return chip;
  return (
    <Tooltip delay={350}>
      <Tooltip.Trigger className="inline-flex cursor-default rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-focus">
        {chip}
      </Tooltip.Trigger>
      <Tooltip.Content className="max-w-72 text-xs leading-relaxed">{tooltip}</Tooltip.Content>
    </Tooltip>
  );
}
