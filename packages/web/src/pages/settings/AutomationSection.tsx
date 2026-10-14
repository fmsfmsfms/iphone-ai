// Automation limits: steps and duration per run, default wait timeout, and
// the (locked) unattended-runs switch.

import { Lock, Thunderbolt } from '@gravity-ui/icons';

import { Panel } from '../../components/Panel';
import { StatusChip } from '../../components/StatusChip';
import { useI18n } from '../../lib/i18n';
import { errorFor } from './helpers';
import { NumberRow, Rows, SaveBar, SettingRow } from './fields';
import { SectionFrame, useSectionAccess } from './SectionFrame';
import { useSectionForm } from './useSectionForm';

export function AutomationSection() {
  const { t } = useI18n();
  const access = useSectionAccess('local');
  const form = useSectionForm('automation', ['unattendedRunsEnabled']);
  const draft = form.draft;
  if (!draft) return null;

  return (
    <SectionFrame title={t('settings.automation.title')} description={t('settings.automation.description')} icon={<Thunderbolt />} access={access}>
      <Panel title={t('settings.automation.limits.title')} description={t('settings.automation.limits.description')}>
        <Rows>
          <NumberRow
            label={t('settings.automation.maxSteps.label')}
            description={t('settings.automation.maxSteps.description')}
            value={draft.maxStepsPerRun}
            onChange={(v) => form.set('maxStepsPerRun', v ?? Number.NaN)}
            minValue={1}
            maxValue={500}
            unit={t('settings.unit.steps')}
            error={errorFor(form.errors, 'maxStepsPerRun')}
          />
          <NumberRow
            label={t('settings.automation.maxDuration.label')}
            description={t('settings.automation.maxDuration.description')}
            value={draft.maxRunDurationSec}
            onChange={(v) => form.set('maxRunDurationSec', v ?? Number.NaN)}
            minValue={10}
            maxValue={7200}
            unit={t('settings.unit.seconds')}
            error={errorFor(form.errors, 'maxRunDurationSec')}
          />
          <NumberRow
            label={t('settings.automation.wait.label')}
            description={t('settings.automation.wait.description')}
            value={draft.defaultWaitTimeoutMs}
            onChange={(v) => form.set('defaultWaitTimeoutMs', v ?? Number.NaN)}
            scale={1000}
            minValue={500}
            maxValue={120000}
            maximumFractionDigits={2}
            unit={t('settings.unit.seconds')}
            error={errorFor(form.errors, 'defaultWaitTimeoutMs')}
          />
        </Rows>
      </Panel>

      <Panel title={t('settings.automation.unattended.title')}>
        <SettingRow
          label={
            <span className="flex items-center gap-2">
              <Lock aria-hidden className="size-3.5 text-muted" />
              {t('settings.automation.unattended.label')}
            </span>
          }
          description={t('settings.automation.unattended.description')}
        >
          <StatusChip tone="default" icon={<Lock />} hideDot label={t('settings.automation.unattended.disabled')} />
        </SettingRow>
      </Panel>

      <SaveBar dirty={form.dirty} status={form.status} error={form.generalError} onSave={() => void form.save()} onDiscard={form.discard} />
    </SectionFrame>
  );
}
