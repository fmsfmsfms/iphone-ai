// AI Providers: active provider, screen-understanding helper for text-only
// models, one card per provider, custom OpenAI-compatible providers and the
// limits every AI task runs under.

import { Eye, Plus, Sparkles, Stopwatch } from '@gravity-ui/icons';
import type { ProviderConfig } from '@iphone-ai/shared';
import { Button } from '@heroui/react';
import { useMemo, useState } from 'react';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Panel } from '../../components/Panel';
import { StatusChip } from '../../components/StatusChip';
import { api } from '../../lib/api';
import { providerReadiness } from '../../lib/device-state';
import { useI18n } from '../../lib/i18n';
import { applySettings, notify, useSettings } from '../../state/store';
import { errorFor, makeCustomProvider, validateProvider } from './helpers';
import { Notice, NumberRow, Rows, SaveBar, SelectInput, SettingRow, SwitchRow, TextInput, useEditable } from './fields';
import { ProviderCard } from './ProviderCard';
import { SectionFrame, useSectionAccess } from './SectionFrame';
import { SavedIndicator, useImmediateSave } from './useImmediateSave';
import { useSectionForm } from './useSectionForm';

const NONE = '__none__';

function AddProviderButton({ existing }: { existing: readonly ProviderConfig[] }) {
  const { t } = useI18n();
  const editable = useEditable();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [vision, setVision] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [touched, setTouched] = useState(false);

  const candidate = useMemo(
    () => makeCustomProvider({ label, baseUrl, model, vision }, existing.map((p) => p.id)),
    [label, baseUrl, model, vision, existing],
  );
  const errors = validateProvider(candidate, t);
  const valid = Object.keys(errors).length === 0;

  const reset = () => {
    setLabel('');
    setBaseUrl('');
    setModel('');
    setVision(false);
    setApiKey('');
    setTouched(false);
  };

  return (
    <>
      <Button size="sm" variant="secondary" isDisabled={!editable} onPress={() => setOpen(true)}>
        <Plus className="size-3.5" />
        {t('settings.providers.add.button')}
      </Button>
      <ConfirmDialog
        isOpen={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
        title={t('settings.providers.add.title')}
        confirmLabel={t('settings.providers.add.confirm')}
        icon={<Plus />}
        size="md"
        isConfirmDisabled={!valid}
        onConfirm={async () => {
          setTouched(true);
          if (!valid) throw new Error(t('settings.save.fixErrors'));
          applySettings(await api.providers.create(candidate));
          if (apiKey.trim()) {
            await api.providers.setSecret(candidate.id, apiKey.trim());
            applySettings(await api.settings.get());
          }
          notify('success', t('settings.providers.add.done', { provider: candidate.label }));
        }}
      >
        <div className="flex flex-col gap-3 text-start">
          <p>{t('settings.providers.add.body')}</p>
          <TextInput
            showLabel
            label={t('settings.providers.label.label')}
            value={label}
            onChange={(v) => {
              setLabel(v);
              setTouched(true);
            }}
            placeholder={t('settings.providers.add.labelPlaceholder')}
            maxLength={80}
            error={touched && label.trim() ? errorFor(errors, 'label') : null}
          />
          <TextInput
            showLabel
            label={t('settings.providers.baseUrl.label')}
            value={baseUrl}
            onChange={(v) => {
              setBaseUrl(v);
              setTouched(true);
            }}
            placeholder="http://127.0.0.1:8000/v1"
            type="url"
            mono
            maxLength={500}
            description={t('settings.providers.baseUrl.compatible')}
            error={touched && baseUrl.trim() ? errorFor(errors, 'baseUrl') : null}
          />
          <TextInput
            showLabel
            label={t('settings.providers.model.label')}
            value={model}
            onChange={setModel}
            placeholder={t('settings.providers.model.placeholder')}
            mono
            maxLength={200}
            description={t('settings.providers.add.modelHint')}
          />
          <TextInput
            showLabel
            label={t('settings.providers.key.inputOptional')}
            value={apiKey}
            onChange={setApiKey}
            type="password"
            mono
            maxLength={500}
            autoComplete="new-password"
            description={t('settings.providers.key.keychain')}
          />
          <div className="rounded-xl border border-hairline px-3 py-1">
            <SwitchRow label={t('settings.providers.vision.label')} description={t('settings.providers.vision.description')} isSelected={vision} onChange={setVision} />
          </div>
          {candidate.baseUrl && candidate.cloud ? <Notice tone="warning">{t('settings.providers.add.cloudNote')}</Notice> : null}
        </div>
      </ConfirmDialog>
    </>
  );
}

function ActiveProviderPanel() {
  const { t } = useI18n();
  const settings = useSettings();
  const editable = useEditable();
  const { pending, savedAt, save } = useImmediateSave();
  if (!settings) return null;
  const providers = settings.ai.providers;
  const active = providers.find((p) => p.id === settings.ai.activeProviderId) ?? null;
  const readiness = providerReadiness(settings);
  const visionCandidates = providers.filter((p) => p.vision && p.enabled && p.id !== active?.id);
  const visionId = settings.ai.visionProviderId;

  return (
    <Panel tone="ai" icon={<Sparkles />} title={t('settings.providers.activePanel.title')} description={t('settings.providers.activePanel.description')} actions={<SavedIndicator at={savedAt} />}>
      <Rows>
        <SettingRow
          label={t('settings.providers.activePanel.current')}
          description={active ? <span dir="ltr" className="font-mono text-[11.5px]">{active.model || t('settings.providers.model.notSet')}</span> : null}
        >
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip tone={readiness.configured ? 'success' : 'warning'} label={active?.label ?? t('provider.none')} tooltip={readiness.reasonKey ? t(readiness.reasonKey) : null} />
            {active ? <StatusChip tone="default" hideDot label={active.cloud ? t('provider.cloud') : t('provider.local')} /> : null}
          </div>
        </SettingRow>
        <SettingRow
          label={t('settings.providers.visionPanel.label')}
          description={
            active && !active.vision ? t('settings.providers.visionPanel.textOnlyActive') : t('settings.providers.visionPanel.description')
          }
        >
          <SelectInput
            label={t('settings.providers.visionPanel.label')}
            value={visionId ?? NONE}
            isDisabled={!editable || pending === 'vision'}
            options={[
              { id: NONE, label: t('settings.providers.visionPanel.none'), description: t('settings.providers.visionPanel.noneHint') },
              ...visionCandidates.map((p) => ({
                id: p.id,
                label: p.label,
                description: p.model || undefined,
                icon: <Eye />,
              })),
            ]}
            onChange={(id) => void save('vision', { ai: { visionProviderId: id === NONE ? null : id } })}
          />
        </SettingRow>
      </Rows>
      {active && !active.vision ? (
        <Notice tone="ai" icon={<Eye />} className="mt-3">
          {t('settings.providers.textOnly.note')}
        </Notice>
      ) : null}
    </Panel>
  );
}

function TaskLimitsPanel() {
  const { t } = useI18n();
  const form = useSectionForm('ai', ['providers', 'activeProviderId', 'visionProviderId']);
  const draft = form.draft;
  if (!draft) return null;
  return (
    <Panel icon={<Stopwatch />} title={t('settings.providers.limits.title')} description={t('settings.providers.limits.description')}>
      <Rows>
        <NumberRow
          label={t('settings.providers.limits.maxActions.label')}
          description={t('settings.providers.limits.maxActions.description')}
          value={draft.maxActionsPerTask}
          onChange={(v) => form.set('maxActionsPerTask', v ?? Number.NaN)}
          minValue={1}
          maxValue={200}
          unit={t('settings.unit.actions')}
          error={errorFor(form.errors, 'maxActionsPerTask')}
        />
        <NumberRow
          label={t('settings.providers.limits.maxDuration.label')}
          description={t('settings.providers.limits.maxDuration.description')}
          value={draft.maxTaskDurationSec}
          onChange={(v) => form.set('maxTaskDurationSec', v ?? Number.NaN)}
          minValue={10}
          maxValue={3600}
          unit={t('settings.unit.seconds')}
          error={errorFor(form.errors, 'maxTaskDurationSec')}
        />
        <NumberRow
          label={t('settings.providers.limits.settle.label')}
          description={t('settings.providers.limits.settle.description')}
          value={draft.settleDelayMs}
          onChange={(v) => form.set('settleDelayMs', v ?? Number.NaN)}
          minValue={100}
          maxValue={5000}
          unit={t('settings.unit.ms')}
          error={errorFor(form.errors, 'settleDelayMs')}
        />
      </Rows>
      <SaveBar dirty={form.dirty} status={form.status} error={form.generalError} onSave={() => void form.save()} onDiscard={form.discard} />
    </Panel>
  );
}

export function ProvidersSection() {
  const { t } = useI18n();
  const settings = useSettings();
  const access = useSectionAccess('local');
  if (!settings) return null;
  const providers = settings.ai.providers;
  const activeId = settings.ai.activeProviderId;

  return (
    <SectionFrame
      title={t('settings.providers.title')}
      description={t('settings.providers.description')}
      icon={<Sparkles />}
      access={access}
      actions={<AddProviderButton existing={providers} />}
    >
      <ActiveProviderPanel />
      <div className="flex flex-col gap-3">
        {providers.map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            isActive={provider.id === activeId}
            isVisionProvider={provider.id === settings.ai.visionProviderId}
            defaultExpanded={provider.id === activeId}
          />
        ))}
      </div>
      <TaskLimitsPanel />
    </SectionFrame>
  );
}
