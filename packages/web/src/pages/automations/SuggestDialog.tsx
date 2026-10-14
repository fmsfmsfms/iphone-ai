// "Suggest with AI": describe a goal, pick a provider, review the suggested
// steps and notes, then open them in the editor. Nothing is saved here.

import { ArrowRotateLeft, Sparkles, TriangleExclamation } from '@gravity-ui/icons';
import type { WorkflowSuggestion } from '@iphone-ai/shared';
import { Button, Modal } from '@heroui/react';
import { useEffect, useState } from 'react';

import { StatusChip } from '../../components/StatusChip';
import { api, errorMessage } from '../../lib/api';
import { providerReadiness } from '../../lib/device-state';
import { useI18n } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { useSettings } from '../../state/store';
import { Notice, SelectInput, TextInput } from './fields';
import { StepIcon } from './StepIcon';
import { stepNameKey, summarizeStep } from './step-meta';

export interface SuggestDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onUse: (suggestion: WorkflowSuggestion) => void;
}

export function SuggestDialog({ isOpen, onOpenChange, onUse }: SuggestDialogProps) {
  const { t } = useI18n();
  const settings = useSettings();
  const [goal, setGoal] = useState('');
  const [providerId, setProviderId] = useState<string>('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<WorkflowSuggestion | null>(null);

  const providers = settings?.ai.providers.filter((p) => p.enabled) ?? [];
  const selectedId = providerId || settings?.ai.activeProviderId || '';
  const readiness = providerReadiness(settings, selectedId);
  const provider = readiness.provider;

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setPending(false);
  }, [isOpen]);

  const suggest = async () => {
    const trimmed = goal.trim();
    if (!trimmed) return;
    setPending(true);
    setError(null);
    setSuggestion(null);
    try {
      setSuggestion(await api.workflows.suggest(trimmed, selectedId || undefined));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  const close = () => {
    if (pending) return;
    onOpenChange(false);
  };

  const use = () => {
    if (!suggestion) return;
    onUse(suggestion);
    onOpenChange(false);
    setSuggestion(null);
    setGoal('');
  };

  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={(open) => (open ? onOpenChange(true) : close())} variant="blur">
      <Modal.Container size="lg" placement="center" scroll="inside">
        <Modal.Dialog className="app-panel bg-overlay">
          <Modal.CloseTrigger />
          <Modal.Header className="flex flex-row items-center gap-3">
            <Modal.Icon className="ai-gradient-bg text-white [&>svg]:size-5">
              <Sparkles />
            </Modal.Icon>
            <div>
              <Modal.Heading className="text-base font-semibold">{t('automations.suggest.title')}</Modal.Heading>
              <p className="text-xs text-muted">{t('automations.suggest.subtitle')}</p>
            </div>
          </Modal.Header>
          <Modal.Body className="flex flex-col gap-4">
            {!suggestion ? (
              <>
                <TextInput
                  label={t('automations.suggest.goal')}
                  value={goal}
                  onChange={setGoal}
                  placeholder={t('automations.suggest.goalPlaceholder')}
                  description={t('automations.suggest.goalHint')}
                  maxLength={2000}
                  multiline
                  rows={4}
                  autoFocus
                  isDisabled={pending}
                />
                {providers.length > 0 ? (
                  <SelectInput
                    label={t('automations.suggest.provider')}
                    value={selectedId}
                    onChange={setProviderId}
                    isDisabled={pending}
                    options={providers.map((p) => ({
                      id: p.id,
                      label: p.label,
                      description: `${p.model || t('provider.defaultModel')} · ${p.cloud ? t('automations.suggest.cloud') : t('automations.suggest.local')}`,
                    }))}
                  />
                ) : null}
                {!readiness.configured ? (
                  <Notice
                    tone="warning"
                    icon={<TriangleExclamation />}
                    actions={
                      <Button size="sm" variant="secondary" onPress={() => navigate({ name: 'settings', section: 'ai' })}>
                        {t('provider.manage')}
                      </Button>
                    }
                  >
                    {provider ? t('automations.suggest.notReady', { provider: provider.label, reason: t(readiness.reasonKey ?? 'provider.reason.none') }) : t('provider.reason.none')}
                  </Notice>
                ) : provider?.cloud ? (
                  <p className="text-[11px] leading-relaxed text-muted">
                    {settings?.privacy.cloudDisclosureAcknowledged
                      ? t('automations.suggest.cloudShared', { provider: provider.label })
                      : t('automations.suggest.cloudGoalOnly', { provider: provider.label })}
                  </p>
                ) : null}
                {error ? (
                  <Notice tone="danger" icon={<TriangleExclamation />} title={t('automations.suggest.error')}>
                    <span dir="auto">{error}</span>
                  </Notice>
                ) : null}
                {pending ? (
                  <p className="flex items-center gap-2 text-xs text-muted" role="status">
                    <span aria-hidden className="status-dot status-dot--pulse text-ai-purple" />
                    {t('automations.suggest.thinking')}
                  </p>
                ) : null}
              </>
            ) : (
              <SuggestionReview suggestion={suggestion} />
            )}
          </Modal.Body>
          <Modal.Footer className="flex flex-wrap justify-end gap-2">
            {!suggestion ? (
              <>
                <Button variant="tertiary" onPress={close} isDisabled={pending}>
                  {t('common.cancel')}
                </Button>
                <Button
                  variant="primary"
                  className="ai-gradient-bg text-white"
                  isPending={pending}
                  isDisabled={!goal.trim() || !readiness.configured}
                  onPress={() => void suggest()}
                >
                  <Sparkles className="size-3.5" />
                  {t('automations.suggest.submit')}
                </Button>
              </>
            ) : (
              <>
                <Button variant="tertiary" onPress={() => setSuggestion(null)}>
                  <ArrowRotateLeft className="size-3.5" />
                  {t('automations.suggest.again')}
                </Button>
                <Button variant="primary" isDisabled={suggestion.steps.length === 0} onPress={use}>
                  {t('automations.suggest.use')}
                </Button>
              </>
            )}
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function SuggestionReview({ suggestion }: { suggestion: WorkflowSuggestion }) {
  const { t, formatNumber } = useI18n();
  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <p dir="auto" className="text-[15px] font-semibold text-foreground">
            {suggestion.name || t('automations.untitled')}
          </p>
          <StatusChip tone="ai" size="sm" hideDot label={t('automations.source.ai-suggested')} icon={<Sparkles />} />
        </div>
        {suggestion.description ? (
          <p dir="auto" className="mt-1 text-[13px] leading-relaxed text-muted">
            {suggestion.description}
          </p>
        ) : null}
      </div>

      {suggestion.notes ? (
        <Notice tone="ai" icon={<Sparkles />} title={t('automations.suggest.notes')}>
          <span dir="auto" className="whitespace-pre-wrap">
            {suggestion.notes}
          </span>
        </Notice>
      ) : null}

      {suggestion.steps.length === 0 ? (
        <Notice tone="warning" icon={<TriangleExclamation />}>
          {t('automations.suggest.noSteps')}
        </Notice>
      ) : (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium text-muted">{t('automations.suggest.steps', { count: suggestion.steps.length })}</p>
          <ol className="flex flex-col gap-1.5">
            {suggestion.steps.map((step, index) => (
              <li key={`${step.id}-${index}`} className="flex items-center gap-2.5 rounded-xl border border-hairline bg-surface-secondary/60 p-2">
                <span className="w-5 shrink-0 text-center text-[11px] text-muted tabular-nums">{formatNumber(index + 1)}</span>
                <StepIcon type={step.type} size="sm" />
                <div className="min-w-0 flex-1">
                  <p dir="auto" className="truncate text-[13px] text-foreground">
                    {summarizeStep(step, t)}
                  </p>
                  <p className="text-[11px] text-muted">{t(stepNameKey(step.type))}</p>
                </div>
              </li>
            ))}
          </ol>
          <p className="text-[11px] leading-relaxed text-muted">{t('automations.suggest.reviewHint')}</p>
        </div>
      )}
    </div>
  );
}
