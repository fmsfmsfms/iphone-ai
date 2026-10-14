// Permissions & safety: control mode, manual control, the AI's allowed
// actions, blocked apps, sensitive-action rules and approval behaviour.

import { Check, Hand, Lock, Plus, Shield, ShieldExclamation, TrashBin } from '@gravity-ui/icons';
import {
  ALWAYS_DENIED_TOOLS,
  CONTROL_MODES,
  DEFAULT_AI_TOOLS,
  DEFAULT_BLOCKED_APPS,
  DEFAULT_SENSITIVE_RULES,
  type ControlMode,
  type SensitiveRule,
} from '@iphone-ai/shared';
import { Button, Checkbox, Label, Tag, TagGroup, TextArea, TextField, type Key } from '@heroui/react';
import { useEffect, useState } from 'react';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Panel } from '../../components/Panel';
import { MODE_ICON, MODE_TONE_CLASS, useModeChange } from '../../app/ControlModeSelector';
import { useI18n } from '../../lib/i18n';
import { notifyError, setManualControl, useAppStore } from '../../state/store';
import { addBlockedApp, deepEqual, errorFor, parseKeywords, ruleIdFromLabel, toggleInList } from './helpers';
import { CompactSwitch, FieldError, Notice, NumberRow, Rows, SaveBar, SelectInput, SwitchRow, TextInput, useEditable } from './fields';
import { SectionFrame, useSectionAccess } from './SectionFrame';
import { useSectionForm } from './useSectionForm';

/** Friendly names for Mirroir tools (falls back to the raw tool name). */
const TOOL_KEYS = new Set([...DEFAULT_AI_TOOLS, ...ALWAYS_DENIED_TOOLS]);

function useToolLabel() {
  const { t } = useI18n();
  return (tool: string) => (TOOL_KEYS.has(tool) ? t(`settings.permissions.tool.${tool}`) : tool);
}

// ---------------------------------------------------------------------------
// Control mode and manual control (dedicated endpoints, applied immediately)
// ---------------------------------------------------------------------------

function ModeCards() {
  const { t } = useI18n();
  const editable = useEditable();
  const { current, request, dialog } = useModeChange();
  return (
    <div role="radiogroup" aria-label={t('mode.label')} className="grid gap-2.5 md:grid-cols-3">
      {CONTROL_MODES.map((mode: ControlMode) => {
        const selected = mode === current;
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={!editable}
            onClick={() => request(mode)}
            className={[
              'app-transition flex flex-col gap-2.5 rounded-2xl border p-3.5 text-start outline-none',
              'hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-60',
              selected ? (mode === 'supervised' ? 'ai-ring border-transparent bg-active' : 'border-accent/60 bg-active') : 'border-hairline',
            ].join(' ')}
          >
            <span className="flex items-center gap-2.5">
              <span aria-hidden className={['flex size-8 shrink-0 items-center justify-center rounded-lg [&>svg]:size-4', MODE_TONE_CLASS[mode]].join(' ')}>
                {MODE_ICON[mode]}
              </span>
              <span className="flex-1 text-[13px] font-semibold text-foreground">{t(`settings.permissions.mode.${mode}`)}</span>
              {selected ? <Check aria-hidden className="size-4 text-accent" /> : null}
            </span>
            <span className="text-xs leading-relaxed text-foreground/85">{t(`mode.${mode}.description`)}</span>
            <ul className="flex flex-col gap-1">
              {[1, 2, 3].map((n) => (
                <li key={n} className="flex gap-2 text-[11.5px] leading-relaxed text-muted">
                  <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-muted" />
                  {t(`mode.${mode}.point${n}`)}
                </li>
              ))}
            </ul>
          </button>
        );
      })}
      {dialog}
    </div>
  );
}

function ManualControlRow() {
  const { t } = useI18n();
  const enabled = useAppStore((s) => s.settings?.permissions.manualControlEnabled ?? false);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const onChange = (next: boolean) => {
    if (next) {
      setConfirming(true);
      return;
    }
    setPending(true);
    setManualControl(false)
      .catch((err: unknown) => notifyError(t('settings.permissions.manual.failed'), err))
      .finally(() => setPending(false));
  };
  return (
    <>
      <SwitchRow
        label={t('settings.permissions.manual.label')}
        description={t('settings.permissions.manual.description')}
        isSelected={enabled}
        isPending={pending}
        onChange={onChange}
      />
      <ConfirmDialog
        isOpen={confirming}
        onOpenChange={setConfirming}
        title={t('settings.permissions.manual.confirmTitle')}
        confirmLabel={t('settings.permissions.manual.confirm')}
        tone="warning"
        icon={<Hand />}
        onConfirm={() => setManualControl(true)}
      >
        <p>{t('settings.permissions.manual.confirmBody')}</p>
        <p className="mt-2">{t('settings.permissions.manual.confirmBody2')}</p>
      </ConfirmDialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Allowed AI tools
// ---------------------------------------------------------------------------

function ToolCheckbox({ tool, checked, onChange, locked }: { tool: string; checked: boolean; onChange?: (on: boolean) => void; locked?: boolean }) {
  const { t } = useI18n();
  const editable = useEditable();
  const label = useToolLabel()(tool);
  return (
    <Checkbox isSelected={checked} onChange={onChange} isDisabled={!editable || locked} variant="secondary" className="min-w-0">
      <Checkbox.Content className="flex w-full items-start gap-2.5 rounded-xl border border-hairline px-3 py-2.5">
        <Checkbox.Control className="mt-0.5">
          <Checkbox.Indicator />
        </Checkbox.Control>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
            {label}
            {locked ? <Lock aria-label={t('settings.permissions.tools.locked')} className="size-3 text-muted" /> : null}
          </span>
          <code dir="ltr" className="font-mono text-[10.5px] text-muted">
            {tool}
          </code>
        </span>
      </Checkbox.Content>
    </Checkbox>
  );
}

// ---------------------------------------------------------------------------
// Blocked apps
// ---------------------------------------------------------------------------

function BlockedAppsEditor({ apps, onChange, error }: { apps: string[]; onChange: (apps: string[]) => void; error: string | null }) {
  const { t } = useI18n();
  const editable = useEditable();
  const [name, setName] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const add = () => {
    const result = addBlockedApp(apps, name);
    if (result.added) {
      onChange(result.list);
      setName('');
      setNote(null);
    } else if (name.trim()) {
      setNote(t('settings.permissions.blocked.duplicate'));
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex flex-wrap items-start gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <TextInput
          label={t('settings.permissions.blocked.input')}
          value={name}
          onChange={(v) => {
            setName(v);
            setNote(null);
          }}
          placeholder={t('settings.permissions.blocked.placeholder')}
          maxLength={120}
          className="min-w-0 flex-1 sm:max-w-72"
        />
        <Button type="submit" size="sm" variant="secondary" className="h-9" isDisabled={!editable || !name.trim()}>
          <Plus className="size-3.5" />
          {t('settings.permissions.blocked.add')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-9"
          isDisabled={!editable || deepEqual(apps, [...DEFAULT_BLOCKED_APPS])}
          onPress={() => onChange([...DEFAULT_BLOCKED_APPS])}
        >
          {t('settings.permissions.blocked.restore')}
        </Button>
      </form>
      {note ? <p className="text-xs text-warning">{note}</p> : null}
      {apps.length === 0 ? (
        <p className="text-xs text-warning">{t('settings.permissions.blocked.empty')}</p>
      ) : (
        <TagGroup
          aria-label={t('settings.permissions.blocked.title')}
          size="sm"
          onRemove={editable ? (keys: Set<Key>) => onChange(apps.filter((app) => !keys.has(app))) : undefined}
        >
          <TagGroup.List className="flex flex-wrap gap-1.5">
            {apps.map((app) => (
              <Tag key={app} id={app} textValue={app}>
                <span dir="auto">{app}</span>
              </Tag>
            ))}
          </TagGroup.List>
        </TagGroup>
      )}
      <FieldError message={error} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sensitive rules
// ---------------------------------------------------------------------------

function RuleEditor({
  rule,
  onChange,
  onRemove,
  errors,
}: {
  rule: SensitiveRule;
  onChange: (rule: SensitiveRule) => void;
  onRemove: () => void;
  errors: { label: string | null; keywords: string | null };
}) {
  const { t } = useI18n();
  const editable = useEditable();
  const [text, setText] = useState(rule.keywords.join(', '));
  // Re-sync when the keywords change from outside (discard, restore defaults, server update).
  useEffect(() => {
    setText((current) => (deepEqual(parseKeywords(current), rule.keywords) ? current : rule.keywords.join(', ')));
  }, [rule.keywords]);

  return (
    <div className={['flex flex-col gap-3 rounded-xl border p-3.5', rule.enabled ? 'border-hairline' : 'border-hairline opacity-70'].join(' ')}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <TextInput
            label={t('settings.permissions.rules.label')}
            value={rule.label}
            onChange={(label) => onChange({ ...rule, label })}
            maxLength={120}
            error={errors.label}
          />
        </div>
        <CompactSwitch label={t('settings.permissions.rules.enabled')} isSelected={rule.enabled} onChange={(enabled) => onChange({ ...rule, enabled })} />
        <Button size="sm" variant="ghost" isIconOnly className="h-9 text-danger" isDisabled={!editable} aria-label={t('settings.permissions.rules.remove')} onPress={onRemove}>
          <TrashBin className="size-3.5" />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-xs font-medium text-muted">{t('settings.permissions.rules.effect')}</span>
        <SelectInput
          label={t('settings.permissions.rules.effect')}
          value={rule.effect}
          options={[
            { id: 'require_approval', label: t('settings.permissions.rules.approval'), description: t('settings.permissions.rules.approvalHint') },
            { id: 'deny', label: t('settings.permissions.rules.deny'), description: t('settings.permissions.rules.denyHint') },
          ]}
          onChange={(effect) => onChange({ ...rule, effect: effect === 'deny' ? 'deny' : 'require_approval' })}
          className="sm:w-56"
        />
      </div>
      <TextField
        value={text}
        onChange={(value) => {
          setText(value);
          onChange({ ...rule, keywords: parseKeywords(value) });
        }}
        isDisabled={!editable}
        isInvalid={Boolean(errors.keywords)}
        className="flex flex-col gap-1"
      >
        <Label className="text-xs font-medium text-muted">{t('settings.permissions.rules.keywords')}</Label>
        <TextArea variant="secondary" rows={2} dir="auto" spellCheck={false} className="min-h-0 resize-y text-[13px]" />
      </TextField>
      <p className="text-[11px] text-muted">{t('settings.permissions.rules.keywordsHint', { count: rule.keywords.length })}</p>
      <FieldError message={errors.keywords} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

export function PermissionsSection() {
  const { t } = useI18n();
  const access = useSectionAccess('local');
  const form = useSectionForm('permissions', ['controlMode', 'manualControlEnabled']);
  const draft = form.draft;
  if (!draft) return null;

  const extraTools = draft.aiAllowedTools.filter((tool) => !DEFAULT_AI_TOOLS.includes(tool) && !ALWAYS_DENIED_TOOLS.includes(tool));
  const rules = draft.sensitiveRules;
  const setRule = (index: number, rule: SensitiveRule) => form.set('sensitiveRules', rules.map((r, i) => (i === index ? rule : r)));
  const addRule = () => {
    const label = t('settings.permissions.rules.newLabel');
    form.set('sensitiveRules', [...rules, { id: ruleIdFromLabel('custom', rules), label, keywords: [], effect: 'require_approval', enabled: true }]);
  };

  return (
    <SectionFrame title={t('settings.permissions.title')} description={t('settings.permissions.description')} icon={<Shield />} access={access}>
      <Panel title={t('settings.permissions.mode.title')} description={t('settings.permissions.mode.description')}>
        <ModeCards />
        <Notice className="mt-3">{t('settings.permissions.mirroirNote')}</Notice>
      </Panel>

      <Panel title={t('settings.permissions.manual.title')}>
        <ManualControlRow />
      </Panel>

      <Panel title={t('settings.permissions.tools.title')} description={t('settings.permissions.tools.description')}>
        <div className="flex flex-col gap-4">
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {[...DEFAULT_AI_TOOLS, ...extraTools].map((tool) => (
              <ToolCheckbox
                key={tool}
                tool={tool}
                checked={draft.aiAllowedTools.includes(tool)}
                onChange={(on) => form.set('aiAllowedTools', toggleInList(draft.aiAllowedTools, tool, on))}
              />
            ))}
          </div>
          <FieldError message={errorFor(form.errors, 'aiAllowedTools')} />
          <div className="flex flex-col gap-2">
            <p className="text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">{t('settings.permissions.tools.lockedTitle')}</p>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {ALWAYS_DENIED_TOOLS.map((tool) => (
                <ToolCheckbox key={tool} tool={tool} checked={false} locked />
              ))}
            </div>
            <p className="text-xs leading-relaxed text-muted">{t('settings.permissions.tools.lockedHint')}</p>
          </div>
        </div>
      </Panel>

      <Panel icon={<ShieldExclamation />} title={t('settings.permissions.blocked.title')} description={t('settings.permissions.blocked.description')}>
        <BlockedAppsEditor apps={draft.blockedApps} onChange={(apps) => form.set('blockedApps', apps)} error={errorFor(form.errors, 'blockedApps')} />
      </Panel>

      <Panel
        title={t('settings.permissions.rules.title')}
        description={t('settings.permissions.rules.description')}
        actions={
          <Button
            size="sm"
            variant="ghost"
            isDisabled={!access.editable || deepEqual(rules, DEFAULT_SENSITIVE_RULES)}
            onPress={() => form.set('sensitiveRules', DEFAULT_SENSITIVE_RULES.map((r) => ({ ...r, keywords: [...r.keywords] })))}
          >
            {t('settings.permissions.rules.restore')}
          </Button>
        }
      >
        <div className="flex flex-col gap-2.5">
          {rules.length === 0 ? <p className="text-xs text-warning">{t('settings.permissions.rules.empty')}</p> : null}
          {rules.map((rule, index) => (
            <RuleEditor
              key={rule.id}
              rule={rule}
              onChange={(next) => setRule(index, next)}
              onRemove={() => form.set('sensitiveRules', rules.filter((_, i) => i !== index))}
              errors={{
                label: errorFor(form.errors, `sensitiveRules.${index}.label`),
                keywords: errorFor(form.errors, `sensitiveRules.${index}.keywords`),
              }}
            />
          ))}
          <FieldError message={form.errors['sensitiveRules'] ?? null} />
          <div>
            <Button size="sm" variant="secondary" isDisabled={!access.editable || rules.length >= 50} onPress={addRule}>
              <Plus className="size-3.5" />
              {t('settings.permissions.rules.add')}
            </Button>
          </div>
        </div>
      </Panel>

      <Panel title={t('settings.permissions.safety.title')}>
        <Rows>
          <SwitchRow
            label={t('settings.permissions.safety.blockTyping.label')}
            description={t('settings.permissions.safety.blockTyping.description')}
            isSelected={draft.blockTypingOnAuthScreens}
            onChange={(v) => form.set('blockTypingOnAuthScreens', v)}
          />
          <NumberRow
            label={t('settings.permissions.safety.timeout.label')}
            description={t('settings.permissions.safety.timeout.description')}
            value={draft.approvalTimeoutSec}
            onChange={(v) => form.set('approvalTimeoutSec', v ?? Number.NaN)}
            minValue={10}
            maxValue={3600}
            unit={t('settings.unit.seconds')}
            error={errorFor(form.errors, 'approvalTimeoutSec')}
          />
          <SwitchRow
            label={t('settings.permissions.safety.audit.label')}
            description={t('settings.permissions.safety.audit.description')}
            isSelected={draft.auditManualActions}
            onChange={(v) => form.set('auditManualActions', v)}
          />
        </Rows>
      </Panel>

      <SaveBar
        dirty={form.dirty}
        status={form.status}
        error={form.generalError}
        onSave={() => void form.save()}
        onDiscard={form.discard}
        note={t('settings.permissions.saveNote')}
      />
    </SectionFrame>
  );
}
