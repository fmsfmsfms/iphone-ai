// Building blocks for settings forms: labelled rows for switches, numbers,
// text and choices, inline errors, the sticky save bar and the read-only
// notice. Fields read the section's editability from context.

import { Check, CircleInfo, FloppyDisk, Lock, TriangleExclamationFill } from '@gravity-ui/icons';
import {
  Button,
  Description,
  Input,
  Label,
  ListBox,
  NumberField,
  Select,
  Spinner,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  type Key,
} from '@heroui/react';
import { createContext, useContext, useId, type ReactNode } from 'react';

import { KbdHint } from '../../components/KbdHint';
import { hasMod, useWindowKeydown } from '../../lib/hotkeys';
import { useI18n } from '../../lib/i18n';
import type { SaveStatus } from './useSectionForm';

// ---------------------------------------------------------------------------
// Editability
// ---------------------------------------------------------------------------

const EditableContext = createContext(true);

export function EditableScope({ editable, children }: { editable: boolean; children: ReactNode }) {
  return <EditableContext.Provider value={editable}>{children}</EditableContext.Provider>;
}

export function useEditable(): boolean {
  return useContext(EditableContext);
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function FieldError({ message, id }: { message: string | null | undefined; id?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="mt-1.5 flex items-start gap-1.5 text-xs leading-relaxed text-danger">
      <TriangleExclamationFill aria-hidden className="mt-0.5 size-3 shrink-0" />
      <span>{message}</span>
    </p>
  );
}

/** Groups rows inside a panel, separated by hairlines. */
export function Rows({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={['flex flex-col divide-y divide-hairline', className ?? ''].join(' ')}>{children}</div>;
}

export interface SettingRowProps {
  label: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  error?: string | null;
  /** Put the control under the text instead of beside it. */
  stacked?: boolean;
  labelId?: string;
  badge?: ReactNode;
}

/** Text on the start side, control on the end side (stacks on narrow widths). */
export function SettingRow({ label, description, children, error, stacked, labelId, badge }: SettingRowProps) {
  return (
    <div className="py-3.5 first:pt-0 last:pb-0">
      <div className={['flex gap-x-6 gap-y-2.5', stacked ? 'flex-col' : 'flex-col sm:flex-row sm:items-center'].join(' ')}>
        <div className="min-w-0 flex-1">
          <p id={labelId} className="flex flex-wrap items-center gap-2 text-[13px] leading-5 font-medium text-foreground">
            {label}
            {badge}
          </p>
          {description ? <div className="mt-0.5 text-xs leading-relaxed text-muted">{description}</div> : null}
        </div>
        <div className={stacked ? 'min-w-0' : 'min-w-0 shrink-0 sm:max-w-[60%]'}>{children}</div>
      </div>
      <FieldError message={error} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Switch
// ---------------------------------------------------------------------------

export interface SwitchRowProps {
  label: ReactNode;
  description?: ReactNode;
  isSelected: boolean;
  onChange: (value: boolean) => void;
  isDisabled?: boolean;
  /** Shown instead of the description when the switch is disabled for a reason. */
  disabledReason?: string | null;
  error?: string | null;
  badge?: ReactNode;
  isPending?: boolean;
}

export function SwitchRow({ label, description, isSelected, onChange, isDisabled, disabledReason, error, badge, isPending }: SwitchRowProps) {
  const editable = useEditable();
  const disabled = !editable || Boolean(isDisabled) || Boolean(isPending);
  return (
    <div className="py-3.5 first:pt-0 last:pb-0">
      <Switch isSelected={isSelected} onChange={onChange} isDisabled={disabled} size="md" className="flex w-full flex-col items-stretch gap-0.5">
        <Switch.Content className="flex w-full items-center gap-4">
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <Label className="text-[13px] leading-5 font-medium text-foreground">{label}</Label>
            {badge}
          </span>
          <Switch.Control className="shrink-0">
            <Switch.Thumb />
          </Switch.Control>
        </Switch.Content>
        {description ? <Description className="block ps-0! pe-14 text-xs leading-relaxed text-muted">{description}</Description> : null}
      </Switch>
      {/* Outside the switch so the explanation isn't dimmed with the disabled control. */}
      {isDisabled && disabledReason ? <p className="mt-1 text-xs leading-relaxed text-warning">{disabledReason}</p> : null}
      <FieldError message={error} />
    </div>
  );
}

/** Small inline switch with its label beside it (rule rows, tables). */
export function CompactSwitch({ label, isSelected, onChange, isDisabled }: { label: string; isSelected: boolean; onChange: (value: boolean) => void; isDisabled?: boolean }) {
  const editable = useEditable();
  return (
    <Switch isSelected={isSelected} onChange={onChange} isDisabled={!editable || isDisabled} size="sm">
      <Switch.Content className="flex h-9 items-center gap-2">
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
        <Label className="text-xs font-medium text-foreground">{label}</Label>
      </Switch.Content>
    </Switch>
  );
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

export interface NumberInputProps {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  minValue?: number;
  maxValue?: number;
  /**
   * Increment step for fractional fields. With a step React Aria snaps values
   * to minValue + k × step, so it is only passed where minValue is a multiple
   * of it; without one, values are only clamped and the buttons add 1.
   */
  step?: number;
  /** Stored value = shown value × scale (e.g. 1000 to show milliseconds as seconds). */
  scale?: number;
  /** Unit shown after the field ("seconds", "fps"). */
  unit?: string;
  /** Empty means "automatic" (null). */
  nullable?: boolean;
  placeholder?: string;
  maximumFractionDigits?: number;
  isDisabled?: boolean;
  invalid?: boolean;
  className?: string;
}

/** Number field without its own label row (the SettingRow provides the visible label). */
export function NumberInput({
  label,
  value,
  onChange,
  minValue,
  maxValue,
  step,
  scale = 1,
  unit,
  nullable,
  placeholder,
  maximumFractionDigits = 0,
  isDisabled,
  invalid,
  className,
}: NumberInputProps) {
  const editable = useEditable();
  const shown = value === null || Number.isNaN(value) ? Number.NaN : value / scale;
  // Room for five to seven digits (ports, token counts) without clipping.
  const wide = maxValue !== undefined && maxValue / scale >= 10000;
  return (
    <div className={['flex items-center gap-2', className ?? ''].join(' ')}>
      <NumberField
        aria-label={label}
        value={shown}
        onChange={(next) => {
          if (next === undefined || Number.isNaN(next)) {
            onChange(nullable ? null : Number.NaN);
            return;
          }
          onChange(Math.round(next * scale * 1e6) / 1e6);
        }}
        minValue={minValue === undefined ? undefined : minValue / scale}
        maxValue={maxValue === undefined ? undefined : maxValue / scale}
        step={step}
        isDisabled={!editable || isDisabled}
        isInvalid={invalid}
        formatOptions={{ maximumFractionDigits, useGrouping: false }}
        variant="secondary"
        className={wide ? 'w-44' : 'w-36'}
      >
        <NumberField.Group className="h-9">
          <NumberField.DecrementButton />
          <NumberField.Input placeholder={placeholder} className="text-center tabular-nums" />
          <NumberField.IncrementButton />
        </NumberField.Group>
      </NumberField>
      {unit ? <span className="min-w-14 text-xs whitespace-nowrap text-muted">{unit}</span> : null}
    </div>
  );
}

export interface NumberRowProps extends Omit<NumberInputProps, 'label' | 'invalid'> {
  label: string;
  description?: ReactNode;
  error?: string | null;
}

export function NumberRow({ label, description, error, ...input }: NumberRowProps) {
  return (
    <SettingRow label={label} description={description} error={error}>
      <NumberInput label={label} invalid={Boolean(error)} {...input} />
    </SettingRow>
  );
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export interface TextInputProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
  type?: 'text' | 'password' | 'url';
  maxLength?: number;
  isDisabled?: boolean;
  invalid?: boolean;
  className?: string;
  autoComplete?: string;
  /** Shows a visible label above the field. */
  showLabel?: boolean;
  description?: ReactNode;
  error?: string | null;
}

export function TextInput({
  label,
  value,
  onChange,
  placeholder,
  mono,
  type = 'text',
  maxLength,
  isDisabled,
  invalid,
  className,
  autoComplete = 'off',
  showLabel,
  description,
  error,
}: TextInputProps) {
  const editable = useEditable();
  return (
    <TextField
      value={value}
      onChange={onChange}
      isDisabled={!editable || isDisabled}
      isInvalid={invalid || Boolean(error)}
      aria-label={showLabel ? undefined : label}
      type={type}
      variant="secondary"
      className={['flex w-full flex-col gap-1', className ?? ''].join(' ')}
    >
      {showLabel ? <Label className="text-xs font-medium text-muted">{label}</Label> : null}
      <Input
        placeholder={placeholder}
        maxLength={maxLength}
        autoComplete={autoComplete}
        spellCheck={false}
        dir={mono ? 'ltr' : 'auto'}
        className={['h-9', mono ? 'font-mono text-[12px]' : ''].join(' ')}
      />
      {description ? <Description className="text-xs leading-relaxed text-muted">{description}</Description> : null}
      <FieldError message={error} />
    </TextField>
  );
}

// ---------------------------------------------------------------------------
// Choices
// ---------------------------------------------------------------------------

export interface ChoiceOption {
  id: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  isDisabled?: boolean;
}

export interface SelectInputProps {
  label: string;
  value: string | null;
  options: readonly ChoiceOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  isDisabled?: boolean;
  invalid?: boolean;
  className?: string;
  showLabel?: boolean;
}

export function SelectInput({ label, value, options, onChange, placeholder, isDisabled, invalid, className, showLabel }: SelectInputProps) {
  const editable = useEditable();
  return (
    <Select
      aria-label={showLabel ? undefined : label}
      value={value}
      onChange={(key) => {
        if (typeof key === 'string' || typeof key === 'number') onChange(String(key));
      }}
      placeholder={placeholder}
      isDisabled={!editable || isDisabled}
      isInvalid={invalid}
      disabledKeys={options.filter((o) => o.isDisabled).map((o) => o.id)}
      variant="secondary"
      className={['w-full min-w-0 sm:w-64', className ?? ''].join(' ')}
    >
      {showLabel ? <Label className="text-xs font-medium text-muted">{label}</Label> : null}
      <Select.Trigger className="h-9">
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox aria-label={label}>
          {options.map((option) => (
            <ListBox.Item key={option.id} id={option.id} textValue={option.label}>
              {option.icon ? <span className="flex size-4 shrink-0 items-center justify-center text-muted [&>svg]:size-4">{option.icon}</span> : null}
              <div className="flex min-w-0 flex-col">
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

export interface SegmentedProps {
  label: string;
  value: string;
  options: readonly ChoiceOption[];
  onChange: (value: string) => void;
  isDisabled?: boolean;
}

/** Single-choice segmented control (theme, language). */
export function Segmented({ label, value, options, onChange, isDisabled }: SegmentedProps) {
  const editable = useEditable();
  return (
    <ToggleButtonGroup
      aria-label={label}
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={new Set<Key>([value])}
      onSelectionChange={(keys) => {
        const next = [...keys][0];
        if (next !== undefined && String(next) !== value) onChange(String(next));
      }}
      isDisabled={!editable || isDisabled}
      size="sm"
    >
      {options.map((option, index) => (
        <ToggleButton key={option.id} id={option.id} className="gap-1.5 px-3">
          {index > 0 ? <ToggleButtonGroup.Separator /> : null}
          {option.icon ? <span className="flex size-3.5 items-center justify-center [&>svg]:size-3.5">{option.icon}</span> : null}
          {option.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}

// ---------------------------------------------------------------------------
// Save bar and notices
// ---------------------------------------------------------------------------

export interface SaveBarProps {
  dirty: boolean;
  status: SaveStatus;
  error: string | null;
  onSave: () => void;
  onDiscard: () => void;
  /** Bind ⌘S while this bar is mounted and dirty. */
  shortcut?: boolean;
  /** Extra text (e.g. "Mirroir restarts briefly"). */
  note?: ReactNode;
}

export function SaveBar({ dirty, status, error, onSave, onDiscard, shortcut = true, note }: SaveBarProps) {
  const { t } = useI18n();
  const editable = useEditable();
  const statusId = useId();
  useWindowKeydown(
    (e) => {
      if (hasMod(e) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty && status !== 'saving') onSave();
      }
    },
    { enabled: shortcut && editable },
  );
  const visible = dirty || status === 'saved' || status === 'saving' || (status === 'error' && error !== null);
  if (!visible || !editable) return null;
  return (
    <div className="sticky bottom-4 z-20 mt-2">
      <div
        role="region"
        aria-label={t('settings.save.region')}
        className="app-glass-strong flex flex-wrap items-center gap-3 rounded-2xl border border-hairline-strong px-4 py-2.5 shadow-[0_12px_32px_rgb(0_0_0/0.35)]"
      >
        <div id={statusId} aria-live="polite" className="flex min-w-0 flex-1 items-center gap-2 text-[13px]">
          {status === 'saving' ? (
            <>
              <Spinner size="sm" />
              <span className="font-medium text-foreground">{t('common.saving')}</span>
            </>
          ) : status === 'saved' && !dirty ? (
            <>
              <Check aria-hidden className="size-4 text-success" />
              <span className="font-medium text-foreground">{t('settings.save.saved')}</span>
            </>
          ) : status === 'error' && error ? (
            <>
              <TriangleExclamationFill aria-hidden className="size-3.5 shrink-0 text-danger" />
              <span className="text-danger">{error}</span>
            </>
          ) : (
            <>
              <span aria-hidden className="size-2 shrink-0 rounded-full bg-warning" />
              <span className="font-medium text-foreground">{t('settings.save.unsaved')}</span>
              {note ? <span className="text-xs text-muted">{note}</span> : null}
            </>
          )}
        </div>
        {dirty ? (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onPress={onDiscard} isDisabled={status === 'saving'}>
              {t('settings.save.discard')}
            </Button>
            <Button size="sm" variant="primary" onPress={onSave} isPending={status === 'saving'} aria-describedby={statusId}>
              {status === 'saving' ? null : <FloppyDisk className="size-3.5" />}
              {status === 'saving' ? t('common.saving') : t('settings.save.button')}
              {shortcut && status !== 'saving' ? <KbdHint keys={['mod', 'S']} light className="ms-1 hidden sm:inline-flex" /> : null}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function Notice({
  tone = 'default',
  icon,
  title,
  children,
  actions,
  className,
}: {
  tone?: 'default' | 'warning' | 'danger' | 'ai' | 'success';
  icon?: ReactNode;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const toneClass = {
    default: 'border-hairline bg-surface-secondary',
    warning: 'border-warning/25 bg-warning/8',
    danger: 'border-danger/30 bg-danger/8',
    ai: 'border-hairline ai-soft-bg',
    success: 'border-success/25 bg-success/8',
  }[tone];
  const iconClass = {
    default: 'text-muted',
    warning: 'text-warning',
    danger: 'text-danger',
    ai: 'text-ai-purple',
    success: 'text-success',
  }[tone];
  return (
    <div className={['flex items-start gap-3 rounded-xl border px-3.5 py-3', toneClass, className ?? ''].join(' ')}>
      <span aria-hidden className={['mt-0.5 flex size-4 shrink-0 items-center justify-center [&>svg]:size-4', iconClass].join(' ')}>
        {icon ?? <CircleInfo />}
      </span>
      <div className="min-w-0 flex-1 text-xs leading-relaxed text-muted">
        {title ? <p className="mb-0.5 text-[13px] font-semibold text-foreground">{title}</p> : null}
        {children}
        {actions ? <div className="mt-2.5 flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

/** Explains why a section can't be edited in this session. */
export function ReadOnlyNotice({ reason }: { reason: string | null }) {
  if (!reason) return null;
  return (
    <Notice tone="warning" icon={<Lock />}>
      <span className="text-foreground">{reason}</span>
    </Notice>
  );
}
