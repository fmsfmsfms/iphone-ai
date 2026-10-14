// One AI provider: configuration form (PUT /api/providers/:id), API key in
// the macOS Keychain, connection test, model list, activation and removal.

import {
  ArrowsRotateRight,
  ChevronDown,
  CircleCheckFill,
  CircleXmarkFill,
  Cloud,
  Cpu,
  House,
  Key,
  Magnifier,
  Sparkles,
  Star,
  Terminal,
  TrashBin,
  TriangleExclamationFill,
} from '@gravity-ui/icons';
import type { ProviderConfig, ProviderTestResult } from '@iphone-ai/shared';
import { Button, Spinner } from '@heroui/react';
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Panel } from '../../components/Panel';
import { StatusChip } from '../../components/StatusChip';
import { api, errorMessage, isApiError, type ClaudeCodeStatus } from '../../lib/api';
import { providerReadiness } from '../../lib/device-state';
import { useI18n } from '../../lib/i18n';
import { applySettings, notify, notifyError, setActiveProvider, useSettings } from '../../state/store';
import {
  deepEqual,
  errorFor,
  isBuiltInProvider,
  parseServerValidation,
  providerRequiresApiKey,
  providerSupportsEffort,
  providerUsesApiKey,
  providerUsesBaseUrl,
  rebaseDraft,
  validateProvider,
  type FieldErrors,
} from './helpers';
import { FieldError, Notice, NumberInput, Rows, SelectInput, SettingRow, SwitchRow, TextInput, useEditable } from './fields';

const KIND_ICON: Record<ProviderConfig['kind'], ReactNode> = {
  anthropic: <Sparkles />,
  'claude-agent-sdk': <Terminal />,
  openai: <Cpu />,
  'openai-compatible': <House />,
};

/** Server-computed fields that always follow the backend. */
const SERVER_FIELDS: readonly (keyof ProviderConfig)[] = ['hasApiKey', 'cloud'];

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

// ---------------------------------------------------------------------------
// API key
// ---------------------------------------------------------------------------

function ApiKeyBlock({ provider }: { provider: ProviderConfig }) {
  const { t } = useI18n();
  const editable = useEditable();
  const [replacing, setReplacing] = useState(false);
  const [value, setValue] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const required = providerRequiresApiKey(provider);

  const saveKey = async () => {
    const apiKey = value.trim();
    if (!apiKey) return;
    setPending(true);
    setError(null);
    try {
      await api.providers.setSecret(provider.id, apiKey);
      setValue('');
      setReplacing(false);
      // hasApiKey is reflected in settings; refresh them so the card updates even without a WS event.
      applySettings(await api.settings.get());
      notify('success', t('settings.providers.key.saved'), t('settings.providers.key.savedBody', { provider: provider.label }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  const showInput = !provider.hasApiKey || replacing;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Key aria-hidden className="size-4 text-muted" />
        <span className="text-[13px] font-medium text-foreground">{t('settings.providers.key.label')}</span>
        {provider.hasApiKey ? (
          <StatusChip size="sm" tone="success" label={t('settings.providers.key.stored')} />
        ) : required ? (
          <StatusChip size="sm" tone="warning" label={t('settings.providers.key.missing')} />
        ) : (
          <StatusChip size="sm" tone="default" label={t('settings.providers.key.optional')} />
        )}
      </div>
      <p className="text-xs leading-relaxed text-muted">{t('settings.providers.key.keychain')}</p>
      {showInput ? (
        <form
          className="flex flex-wrap items-start gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void saveKey();
          }}
        >
          <TextInput
            label={t('settings.providers.key.input')}
            value={value}
            onChange={setValue}
            type="password"
            placeholder={t('settings.providers.key.placeholder')}
            mono
            maxLength={500}
            autoComplete="new-password"
            className="min-w-0 flex-1 sm:min-w-64"
          />
          <Button type="submit" size="sm" variant="primary" className="h-9" isDisabled={!editable || !value.trim()} isPending={pending}>
            {t('settings.providers.key.save')}
          </Button>
          {replacing ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-9"
              onPress={() => {
                setReplacing(false);
                setValue('');
                setError(null);
              }}
            >
              {t('common.cancel')}
            </Button>
          ) : null}
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" isDisabled={!editable} onPress={() => setReplacing(true)}>
            {t('settings.providers.key.replace')}
          </Button>
          <Button size="sm" variant="ghost" className="text-danger" isDisabled={!editable} onPress={() => setConfirmRemove(true)}>
            {t('settings.providers.key.remove')}
          </Button>
        </div>
      )}
      <FieldError message={error} />
      <ConfirmDialog
        isOpen={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={t('settings.providers.key.removeTitle', { provider: provider.label })}
        confirmLabel={t('settings.providers.key.remove')}
        tone="danger"
        icon={<Key />}
        onConfirm={async () => {
          await api.providers.deleteSecret(provider.id);
          applySettings(await api.settings.get());
        }}
      >
        <p>{t('settings.providers.key.removeBody')}</p>
      </ConfirmDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Claude Code login status
// ---------------------------------------------------------------------------

function ClaudeCodeStatusBlock() {
  const { t } = useI18n();
  const [status, setStatus] = useState<ClaudeCodeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await api.providers.claudeCodeStatus());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const row = (ok: boolean, label: string, detail?: string | null) => (
    <li className="flex items-start gap-2.5">
      {ok ? <CircleCheckFill aria-hidden className="mt-0.5 size-4 shrink-0 text-success" /> : <CircleXmarkFill aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />}
      <span className="min-w-0">
        <span className="block text-[13px] text-foreground">{label}</span>
        {detail ? (
          <code dir="ltr" className="block font-mono text-[11px] break-all text-muted">
            {detail}
          </code>
        ) : null}
      </span>
    </li>
  );

  return (
    <div className="flex flex-col gap-3">
      <Notice tone="warning" icon={<TriangleExclamationFill />} title={t('settings.providers.claudeCode.personalTitle')}>
        {t('settings.providers.claudeCode.personalBody')}
      </Notice>
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[13px] font-medium text-foreground">{t('settings.providers.claudeCode.status')}</span>
        <Button size="sm" variant="ghost" isPending={loading} onPress={() => void load()}>
          {loading ? null : <ArrowsRotateRight className="size-3.5" />}
          {t('settings.providers.claudeCode.check')}
        </Button>
      </div>
      {error ? (
        <FieldError message={error} />
      ) : status ? (
        <ul className="flex flex-col gap-2">
          {row(status.available, status.available ? t('settings.providers.claudeCode.found') : t('settings.providers.claudeCode.notFound'), status.binaryPath)}
          {row(
            status.loggedIn,
            status.loggedIn ? t('settings.providers.claudeCode.loggedIn', { method: status.authMethod || '—' }) : t('settings.providers.claudeCode.loggedOut'),
          )}
          {status.detail ? (
            <li className="text-xs leading-relaxed text-muted" dir="auto">
              {status.detail}
            </li>
          ) : null}
        </ul>
      ) : (
        <Spinner size="sm" />
      )}
      {status && !status.loggedIn ? <p className="text-xs leading-relaxed text-muted">{t('settings.providers.claudeCode.howToLogin')}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Test result
// ---------------------------------------------------------------------------

function TestResult({ result }: { result: ProviderTestResult }) {
  const { t, formatNumber } = useI18n();
  const flag = (value: boolean | null, yes: string, no: string) =>
    value === null ? null : <StatusChip size="sm" tone={value ? 'success' : 'default'} label={value ? yes : no} />;
  return (
    <div
      role="status"
      className={['flex flex-col gap-2 rounded-xl border p-3', result.ok ? 'border-success/25 bg-success/8' : 'border-danger/30 bg-danger/8'].join(' ')}
    >
      <div className="flex flex-wrap items-center gap-2">
        {result.ok ? <CircleCheckFill aria-hidden className="size-4 text-success" /> : <CircleXmarkFill aria-hidden className="size-4 text-danger" />}
        <span className="text-[13px] font-semibold text-foreground">{result.ok ? t('settings.providers.test.ok') : t('settings.providers.test.failed')}</span>
        <span className="text-xs text-muted tabular-nums">{t('settings.providers.test.latency', { ms: formatNumber(Math.round(result.latencyMs)) })}</span>
      </div>
      {result.message ? (
        <p dir="auto" className="text-xs leading-relaxed break-words text-foreground/85">
          {result.message}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        {result.model ? <StatusChip size="sm" tone="default" hideDot label={result.model} /> : null}
        {flag(result.supportsTools, t('settings.providers.test.tools'), t('settings.providers.test.noTools'))}
        {flag(result.supportsVision, t('settings.providers.test.vision'), t('settings.providers.test.noVision'))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export interface ProviderCardProps {
  provider: ProviderConfig;
  isActive: boolean;
  isVisionProvider: boolean;
  defaultExpanded?: boolean;
}

export function ProviderCard({ provider, isActive, isVisionProvider, defaultExpanded }: ProviderCardProps) {
  const { t } = useI18n();
  const editable = useEditable();
  const settings = useSettings();
  const bodyId = useId();
  const [expanded, setExpanded] = useState(Boolean(defaultExpanded));
  const [form, setForm] = useState({ base: provider, draft: provider });
  const { base, draft } = form;
  const [saving, setSaving] = useState(false);
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<ProviderTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [models, setModels] = useState<string[] | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Follow server changes without losing local edits.
  useEffect(() => {
    setForm((f) => ({ base: provider, draft: rebaseDraft(f.base, f.draft, provider, SERVER_FIELDS) }));
  }, [provider]);

  const dirty = useMemo(
    () => (Object.keys(draft) as (keyof ProviderConfig)[]).some((k) => !SERVER_FIELDS.includes(k) && !deepEqual(draft[k], base[k])),
    [draft, base],
  );
  const clientErrors = useMemo(() => (dirty ? validateProvider(draft, t) : {}), [dirty, draft, t]);
  const errors = { ...serverErrors, ...clientErrors };
  const readiness = providerReadiness(settings, provider.id);

  const set = <K extends keyof ProviderConfig>(key: K, value: ProviderConfig[K]) => {
    setServerErrors({});
    setGeneralError(null);
    setForm((f) => ({ ...f, draft: { ...f.draft, [key]: value } }));
  };

  const save = async () => {
    if (Object.keys(clientErrors).length > 0) {
      setGeneralError(t('settings.save.fixErrors'));
      return;
    }
    setSaving(true);
    setGeneralError(null);
    try {
      applySettings(await api.providers.update(draft));
      notify('success', t('settings.providers.saved', { provider: draft.label }));
    } catch (err) {
      if (isApiError(err) && err.code === 'validation_error') {
        const parsed = parseServerValidation(err.message, '');
        setServerErrors(parsed.fields);
        setGeneralError(parsed.general ?? t('settings.save.fixErrors'));
      } else {
        setGeneralError(errorMessage(err));
      }
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    setTestError(null);
    try {
      setTest(await api.providers.test(provider.id));
    } catch (err) {
      setTestError(errorMessage(err));
    } finally {
      setTesting(false);
    }
  };

  const fetchModels = async () => {
    setModelsLoading(true);
    setModelsError(null);
    try {
      const list = await api.providers.models(provider.id);
      setModels(list);
      if (list.length === 0) setModelsError(t('settings.providers.model.none'));
    } catch (err) {
      setModelsError(errorMessage(err));
    } finally {
      setModelsLoading(false);
    }
  };

  const activate = async () => {
    setActivating(true);
    try {
      await setActiveProvider(provider.id);
      notify('success', t('settings.providers.activated', { provider: provider.label }));
    } catch (err) {
      notifyError(t('provider.switchFailed'), err);
    } finally {
      setActivating(false);
    }
  };

  const custom = !isBuiltInProvider(provider.id);
  const modelOptions = useMemo(() => {
    const list = models ?? [];
    const all = draft.model && !list.includes(draft.model) ? [draft.model, ...list] : list;
    return all.map((m) => ({ id: m, label: m }));
  }, [models, draft.model]);

  const summary: string[] = [];
  summary.push(provider.model || t('settings.providers.model.notSet'));
  summary.push(provider.vision ? t('settings.providers.vision.short') : t('settings.providers.textOnly.short'));

  return (
    <Panel
      tone={isActive ? 'ai' : 'default'}
      className={provider.enabled ? '' : 'opacity-80'}
      bodyClassName={expanded ? '' : 'hidden'}
      icon={KIND_ICON[provider.kind]}
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span dir="auto">{provider.label}</span>
          {isActive ? <StatusChip size="sm" tone="accent" icon={<Star />} hideDot label={t('settings.providers.active')} /> : null}
          {isVisionProvider ? <StatusChip size="sm" tone="accent" hideDot label={t('settings.providers.visionHelper')} /> : null}
          <StatusChip
            size="sm"
            tone="default"
            hideDot
            icon={provider.cloud ? <Cloud /> : <House />}
            label={provider.cloud ? t('provider.cloud') : t('provider.local')}
          />
          {!provider.enabled ? <StatusChip size="sm" tone="default" label={t('settings.providers.off')} /> : null}
        </span>
      }
      description={
        <span className="flex flex-col gap-0.5">
          <span dir="ltr" className="font-mono text-[11.5px]">
            {summary.join(' · ')}
          </span>
          {readiness.reasonKey && provider.enabled ? <span className="text-warning">{t(readiness.reasonKey)}</span> : null}
        </span>
      }
      actions={
        <>
          {!isActive ? (
            <Button
              size="sm"
              variant="secondary"
              isPending={activating}
              isDisabled={!editable || !provider.enabled}
              onPress={() => void activate()}
            >
              {t('settings.providers.setActive')}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            isIconOnly
            aria-expanded={expanded}
            aria-controls={bodyId}
            aria-label={expanded ? t('settings.providers.collapse') : t('settings.providers.expand')}
            onPress={() => setExpanded((e) => !e)}
          >
            <ChevronDown className={['size-4 transition-transform', expanded ? 'rotate-180' : ''].join(' ')} />
          </Button>
        </>
      }
    >
      <div id={bodyId} className="flex flex-col gap-5 border-t border-hairline pt-4">
        <Rows>
          <SwitchRow
            label={t('settings.providers.enabled.label')}
            description={t('settings.providers.enabled.description')}
            isSelected={draft.enabled}
            onChange={(v) => set('enabled', v)}
          />
          <SettingRow label={t('settings.providers.label.label')} error={errorFor(errors, 'label')}>
            <TextInput label={t('settings.providers.label.label')} value={draft.label} onChange={(v) => set('label', v)} maxLength={80} className="sm:w-64" />
          </SettingRow>
          {providerUsesBaseUrl(draft) ? (
            <SettingRow
              label={t('settings.providers.baseUrl.label')}
              description={draft.kind === 'openai-compatible' ? t('settings.providers.baseUrl.compatible') : t('settings.providers.baseUrl.optional')}
              error={errorFor(errors, 'baseUrl')}
              stacked
            >
              <TextInput
                label={t('settings.providers.baseUrl.label')}
                value={draft.baseUrl ?? ''}
                onChange={(v) => set('baseUrl', v.trim() ? v.trim() : null)}
                placeholder={draft.kind === 'openai-compatible' ? 'http://127.0.0.1:1234/v1' : t('settings.providers.baseUrl.default')}
                type="url"
                mono
                maxLength={500}
              />
            </SettingRow>
          ) : null}
          <SettingRow label={t('settings.providers.model.label')} description={t('settings.providers.model.description')} error={errorFor(errors, 'model')} stacked>
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-start gap-2">
                <TextInput
                  label={t('settings.providers.model.label')}
                  value={draft.model}
                  onChange={(v) => set('model', v.trim())}
                  placeholder={t('settings.providers.model.placeholder')}
                  mono
                  maxLength={200}
                  className="min-w-0 flex-1 sm:min-w-64"
                />
                <Button size="sm" variant="secondary" className="h-9" isPending={modelsLoading} onPress={() => void fetchModels()}>
                  {modelsLoading ? null : <Magnifier className="size-3.5" />}
                  {t('settings.providers.model.fetch')}
                </Button>
              </div>
              {models && models.length > 0 ? (
                <SelectInput
                  label={t('settings.providers.model.pick')}
                  value={draft.model || null}
                  placeholder={t('settings.providers.model.pick')}
                  options={modelOptions}
                  onChange={(m) => set('model', m)}
                  className="sm:w-full"
                />
              ) : null}
              {modelsError ? <p className="text-xs text-warning">{modelsError}</p> : null}
              <p className="text-[11px] text-muted">{t('settings.providers.model.savedConfigHint')}</p>
            </div>
          </SettingRow>
          <SwitchRow
            label={t('settings.providers.vision.label')}
            description={t('settings.providers.vision.description')}
            isSelected={draft.vision}
            onChange={(v) => set('vision', v)}
          />
          <SettingRow label={t('settings.providers.maxOutput.label')} error={errorFor(errors, 'maxOutputTokens')}>
            <NumberInput
              label={t('settings.providers.maxOutput.label')}
              value={draft.maxOutputTokens}
              onChange={(v) => set('maxOutputTokens', v ?? Number.NaN)}
              minValue={256}
              maxValue={128000}
              unit={t('settings.unit.tokens')}
              invalid={Boolean(errorFor(errors, 'maxOutputTokens'))}
            />
          </SettingRow>
          <SettingRow
            label={t('settings.providers.context.label')}
            description={t('settings.providers.context.description')}
            error={errorFor(errors, 'contextTokens')}
          >
            <NumberInput
              label={t('settings.providers.context.label')}
              value={draft.contextTokens}
              onChange={(v) => set('contextTokens', v)}
              nullable
              placeholder={t('settings.providers.context.auto')}
              minValue={2048}
              maxValue={2000000}
              unit={t('settings.unit.tokens')}
              invalid={Boolean(errorFor(errors, 'contextTokens'))}
            />
          </SettingRow>
          <SettingRow label={t('settings.providers.timeout.label')} error={errorFor(errors, 'timeoutMs')}>
            <NumberInput
              label={t('settings.providers.timeout.label')}
              value={draft.timeoutMs}
              onChange={(v) => set('timeoutMs', v ?? Number.NaN)}
              scale={1000}
              minValue={5000}
              maxValue={900000}
              unit={t('settings.unit.seconds')}
              invalid={Boolean(errorFor(errors, 'timeoutMs'))}
            />
          </SettingRow>
          {providerSupportsEffort(draft) ? (
            <SettingRow label={t('settings.providers.effort.label')} description={t('settings.providers.effort.description')}>
              <SelectInput
                label={t('settings.providers.effort.label')}
                value={draft.effort ?? 'default'}
                options={[
                  { id: 'default', label: t('settings.providers.effort.default') },
                  ...EFFORTS.map((e) => ({ id: e, label: t(`settings.providers.effort.${e}`) })),
                ]}
                onChange={(v) => set('effort', v === 'default' ? null : (v as (typeof EFFORTS)[number]))}
                className="sm:w-48"
              />
            </SettingRow>
          ) : null}
        </Rows>

        {dirty || generalError ? (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-hairline bg-surface-secondary px-3 py-2">
            <span className="flex-1 text-xs text-muted">{generalError ? <span className="text-danger">{generalError}</span> : t('settings.save.unsaved')}</span>
            <Button
              size="sm"
              variant="ghost"
              isDisabled={saving}
              onPress={() => {
                setForm((f) => ({ ...f, draft: f.base }));
                setServerErrors({});
                setGeneralError(null);
              }}
            >
              {t('settings.save.discard')}
            </Button>
            <Button size="sm" variant="primary" isDisabled={!editable || !dirty} isPending={saving} onPress={() => void save()}>
              {t('settings.save.button')}
            </Button>
          </div>
        ) : null}

        {provider.kind === 'claude-agent-sdk' ? <ClaudeCodeStatusBlock /> : null}
        {providerUsesApiKey(provider) ? <ApiKeyBlock provider={provider} /> : null}
        {provider.kind === 'openai' ? (
          <Notice tone="default">{t('settings.providers.openai.subscriptionNote')}</Notice>
        ) : null}
        {!provider.vision ? <Notice tone="default">{t('settings.providers.textOnly.note')}</Notice> : null}

        <div className="flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" isPending={testing} isDisabled={!editable || dirty} onPress={() => void runTest()}>
              {testing ? null : <ArrowsRotateRight className="size-3.5" />}
              {t('settings.providers.test.button')}
            </Button>
            {dirty ? <span className="text-xs text-muted">{t('settings.providers.test.saveFirst')}</span> : null}
            {custom ? (
              <Button size="sm" variant="ghost" className="ms-auto text-danger" isDisabled={!editable} onPress={() => setConfirmDelete(true)}>
                <TrashBin className="size-3.5" />
                {t('settings.providers.delete.button')}
              </Button>
            ) : null}
          </div>
          {testing ? (
            <p className="flex items-center gap-2 text-xs text-muted">
              <Spinner size="sm" />
              {t('settings.providers.test.running')}
            </p>
          ) : null}
          {test ? <TestResult result={test} /> : null}
          <FieldError message={testError} />
        </div>
      </div>

      <ConfirmDialog
        isOpen={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('settings.providers.delete.title', { provider: provider.label })}
        confirmLabel={t('settings.providers.delete.confirm')}
        tone="danger"
        icon={<TrashBin />}
        onConfirm={async () => {
          applySettings(await api.providers.remove(provider.id));
          notify('success', t('settings.providers.delete.done', { provider: provider.label }));
        }}
      >
        <p>{t('settings.providers.delete.body')}</p>
      </ConfirmDialog>
    </Panel>
  );
}
