// Small labelled form controls used by the step forms and dialogs (HeroUI
// TextField / NumberField / Select / Switch with consistent spacing and errors).

import { Description, FieldError, Input, Label, ListBox, NumberField, Select, Switch, TextArea, TextField } from '@heroui/react';
import type { ReactNode } from 'react';

export interface TextInputProps {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  description?: ReactNode;
  placeholder?: string;
  maxLength?: number;
  multiline?: boolean;
  rows?: number;
  type?: 'text' | 'password' | 'url';
  mono?: boolean;
  autoFocus?: boolean;
  isRequired?: boolean;
  isDisabled?: boolean;
  className?: string;
  /** Text typed by the user (not interface copy): let the browser pick the direction. */
  dirAuto?: boolean;
}

export function TextInput({
  label,
  value,
  onChange,
  error,
  description,
  placeholder,
  maxLength,
  multiline,
  rows = 3,
  type = 'text',
  mono,
  autoFocus,
  isRequired,
  isDisabled,
  className,
  dirAuto = true,
}: TextInputProps) {
  const fieldClass = mono ? 'font-mono text-[12px]' : '';
  return (
    <TextField
      value={value}
      onChange={onChange}
      isInvalid={Boolean(error)}
      isRequired={isRequired}
      isDisabled={isDisabled}
      variant="secondary"
      className={['flex flex-col gap-1.5', className ?? ''].join(' ')}
    >
      <Label className="text-xs font-medium text-muted">{label}</Label>
      {multiline ? (
        <TextArea
          variant="secondary"
          rows={rows}
          placeholder={placeholder}
          maxLength={maxLength}
          autoFocus={autoFocus}
          dir={dirAuto ? 'auto' : undefined}
          className={['min-h-0 resize-y text-[13px]', fieldClass].join(' ')}
        />
      ) : (
        <Input
          variant="secondary"
          type={type}
          placeholder={placeholder}
          maxLength={maxLength}
          autoFocus={autoFocus}
          autoComplete="off"
          spellCheck={type === 'text' && !mono}
          dir={dirAuto ? 'auto' : undefined}
          className={['text-[13px]', fieldClass].join(' ')}
        />
      )}
      {description && !error ? <Description className="text-[11px] leading-relaxed text-muted">{description}</Description> : null}
      <FieldError className="text-[11px] text-danger">{error}</FieldError>
    </TextField>
  );
}

export interface NumberInputProps {
  label: ReactNode;
  /** `undefined` = empty (optional fields). */
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  min?: number;
  max?: number;
  step?: number;
  error?: string | null;
  description?: ReactNode;
  maximumFractionDigits?: number;
  className?: string;
  isDisabled?: boolean;
}

export function NumberInput({ label, value, onChange, min, max, step, error, description, maximumFractionDigits = 0, className, isDisabled }: NumberInputProps) {
  return (
    <NumberField
      value={value ?? Number.NaN}
      onChange={(next) => onChange(next === undefined || Number.isNaN(next) ? undefined : next)}
      minValue={min}
      maxValue={max}
      step={step}
      isInvalid={Boolean(error)}
      isDisabled={isDisabled}
      formatOptions={{ maximumFractionDigits }}
      variant="secondary"
      className={['flex flex-col gap-1.5', className ?? ''].join(' ')}
    >
      <Label className="text-xs font-medium text-muted">{label}</Label>
      <NumberField.Group>
        <NumberField.DecrementButton />
        <NumberField.Input className="min-w-0 text-[13px] tabular-nums" />
        <NumberField.IncrementButton />
      </NumberField.Group>
      {description && !error ? <Description className="text-[11px] leading-relaxed text-muted">{description}</Description> : null}
      <FieldError className="text-[11px] text-danger">{error}</FieldError>
    </NumberField>
  );
}

export interface SelectOption {
  id: string;
  label: string;
  description?: string;
}

export interface SelectInputProps {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  description?: ReactNode;
  className?: string;
  isDisabled?: boolean;
}

export function SelectInput({ label, value, onChange, options, description, className, isDisabled }: SelectInputProps) {
  return (
    <Select
      value={value}
      onChange={(key) => {
        if (typeof key === 'string' || typeof key === 'number') onChange(String(key));
      }}
      isDisabled={isDisabled}
      variant="secondary"
      className={['flex flex-col gap-1.5', className ?? ''].join(' ')}
    >
      <Label className="text-xs font-medium text-muted">{label}</Label>
      <Select.Trigger className="text-[13px]">
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      {description ? <Description className="text-[11px] leading-relaxed text-muted">{description}</Description> : null}
      <Select.Popover>
        <ListBox>
          {options.map((option) => (
            <ListBox.Item key={option.id} id={option.id} textValue={option.label}>
              <div className="flex flex-col">
                <Label>{option.label}</Label>
                {option.description ? <Description>{option.description}</Description> : null}
              </div>
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

export interface ToggleRowProps {
  label: ReactNode;
  description?: ReactNode;
  isSelected: boolean;
  onChange: (value: boolean) => void;
  isDisabled?: boolean;
  className?: string;
}

export function ToggleRow({ label, description, isSelected, onChange, isDisabled, className }: ToggleRowProps) {
  return (
    <Switch isSelected={isSelected} onChange={onChange} isDisabled={isDisabled} size="sm" className={className}>
      <Switch.Content className="flex w-full items-center gap-3">
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
        <Label className="flex-1 text-[13px] font-medium text-foreground">{label}</Label>
      </Switch.Content>
      {description ? <Description className="mt-1 block ps-12 text-[11px] leading-relaxed text-muted">{description}</Description> : null}
    </Switch>
  );
}

/** Inline notice used inside step forms and panels. */
export function Notice({ tone = 'default', icon, title, children, actions, className }: {
  tone?: 'default' | 'warning' | 'danger' | 'ai' | 'success';
  icon?: ReactNode;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const toneClass = {
    default: 'border-hairline bg-default/40 text-muted',
    warning: 'border-warning/30 bg-warning/8 text-warning',
    danger: 'border-danger/35 bg-danger/8 text-danger',
    ai: 'border-transparent ai-soft-bg text-ai-purple',
    success: 'border-success/30 bg-success/8 text-success',
  }[tone];
  return (
    <div role={tone === 'danger' ? 'alert' : 'note'} className={['flex gap-2.5 rounded-xl border p-3', toneClass, className ?? ''].join(' ')}>
      {icon ? <span aria-hidden className="mt-0.5 shrink-0 [&>svg]:size-4">{icon}</span> : null}
      <div className="min-w-0 flex-1">
        {title ? <p className="text-[13px] font-semibold text-foreground">{title}</p> : null}
        {children ? <div className={['text-xs leading-relaxed text-muted', title ? 'mt-0.5' : ''].join(' ')}>{children}</div> : null}
        {actions ? <div className="mt-2.5 flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
