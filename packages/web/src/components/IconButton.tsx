// Icon-only (or compact) button with a tooltip that shows its label, an
// optional keyboard shortcut, or — when disabled — the reason why.

import { Button, Tooltip } from '@heroui/react';
import type { ReactNode } from 'react';

import { KbdHint, type ShortcutKey } from './KbdHint';

export interface IconButtonProps {
  label: string;
  icon: ReactNode;
  onPress?: () => void;
  shortcut?: readonly ShortcutKey[];
  isDisabled?: boolean;
  /** Shown in the tooltip instead of the label when the button is disabled. */
  disabledReason?: string | null;
  isPending?: boolean;
  variant?: 'primary' | 'secondary' | 'tertiary' | 'outline' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  /** Render the label next to the icon instead of icon-only. */
  showLabel?: boolean;
  className?: string;
  placement?: 'top' | 'bottom' | 'left' | 'right' | 'start' | 'end';
  isSelected?: boolean;
}

export function IconButton({
  label,
  icon,
  onPress,
  shortcut,
  isDisabled,
  disabledReason,
  isPending,
  variant = 'ghost',
  size = 'sm',
  showLabel,
  className,
  placement = 'top',
  isSelected,
}: IconButtonProps) {
  const disabled = Boolean(isDisabled || isPending);
  const button = (
    <Button
      aria-label={label}
      isIconOnly={!showLabel}
      isDisabled={disabled}
      isPending={isPending}
      variant={variant}
      size={size}
      onPress={onPress}
      aria-pressed={isSelected}
      className={[
        'app-transition [&_svg]:size-4',
        isSelected ? 'bg-active text-foreground' : '',
        className ?? '',
      ].join(' ')}
    >
      {icon}
      {showLabel ? <span className="truncate">{label}</span> : null}
    </Button>
  );
  const tooltipBody =
    isDisabled && disabledReason ? (
      <span className="block max-w-64 leading-relaxed">{disabledReason}</span>
    ) : (
      <span className="flex items-center gap-2">
        <span>{label}</span>
        {shortcut && shortcut.length > 0 ? <KbdHint keys={shortcut} /> : null}
      </span>
    );
  return (
    <Tooltip delay={400} closeDelay={0}>
      {disabled ? (
        // Disabled buttons receive no hover events; the wrapper keeps the explanation reachable.
        <Tooltip.Trigger className="inline-flex rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-focus" aria-label={label}>
          {button}
        </Tooltip.Trigger>
      ) : (
        button
      )}
      <Tooltip.Content placement={placement} className="text-xs">
        {tooltipBody}
      </Tooltip.Content>
    </Tooltip>
  );
}
