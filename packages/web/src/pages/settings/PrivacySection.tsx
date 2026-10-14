// Privacy: what is stored and for how long, the cloud-model disclosure, and
// deleting local data (POST /api/privacy/delete).

import { Cloud, EyeSlash, TrashBin, TriangleExclamationFill } from '@gravity-ui/icons';
import { Button, Checkbox, Description } from '@heroui/react';
import { useState } from 'react';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Panel } from '../../components/Panel';
import { StatusChip } from '../../components/StatusChip';
import { api, type PrivacyDeleteRequest } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { notify, useSettings } from '../../state/store';
import { errorFor } from './helpers';
import { Notice, NumberRow, Rows, SaveBar, SettingRow, SwitchRow, useEditable } from './fields';
import { SectionFrame, useSectionAccess } from './SectionFrame';
import { SavedIndicator, useImmediateSave } from './useImmediateSave';
import { useSectionForm } from './useSectionForm';

type DeleteKey = keyof PrivacyDeleteRequest;
const DELETE_KEYS: readonly DeleteKey[] = ['activity', 'conversations', 'approvals', 'screenshots'];

function DeleteDataButton() {
  const { t } = useI18n();
  const editable = useEditable();
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<Record<DeleteKey, boolean>>({ activity: false, conversations: false, approvals: false, screenshots: false });
  const any = DELETE_KEYS.some((k) => selection[k]);

  return (
    <>
      <Button size="sm" variant="danger" isDisabled={!editable} onPress={() => setOpen(true)}>
        <TrashBin className="size-3.5" />
        {t('settings.privacy.delete.button')}
      </Button>
      <ConfirmDialog
        isOpen={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setSelection({ activity: false, conversations: false, approvals: false, screenshots: false });
        }}
        title={t('settings.privacy.delete.title')}
        confirmLabel={t('settings.privacy.delete.confirm')}
        tone="danger"
        icon={<TrashBin />}
        size="md"
        isConfirmDisabled={!any}
        onConfirm={async () => {
          const body: PrivacyDeleteRequest = {};
          for (const key of DELETE_KEYS) if (selection[key]) body[key] = true;
          const result = await api.privacy.delete(body);
          const parts = Object.entries(result.deleted).map(([what, count]) =>
            t('settings.privacy.delete.resultItem', { what: t(`settings.privacy.delete.${what}.label`), count }),
          );
          notify('success', t('settings.privacy.delete.done'), parts.join(' · ') || undefined);
        }}
      >
        <div className="flex flex-col gap-3 text-start">
          <p>{t('settings.privacy.delete.body')}</p>
          <div className="flex flex-col gap-2">
            {DELETE_KEYS.map((key) => (
              <Checkbox
                key={key}
                isSelected={selection[key]}
                onChange={(on) => setSelection((s) => ({ ...s, [key]: on }))}
                variant="secondary"
                className="rounded-xl border border-hairline px-3 py-2.5"
              >
                <Checkbox.Content className="flex items-start gap-2.5">
                  <Checkbox.Control className="mt-0.5">
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  <span className="text-[13px] font-medium text-foreground">{t(`settings.privacy.delete.${key}.label`)}</span>
                </Checkbox.Content>
                <Description className="ps-7 text-xs leading-relaxed text-muted">{t(`settings.privacy.delete.${key}.description`)}</Description>
              </Checkbox>
            ))}
          </div>
          <p className="text-xs text-danger">{t('settings.privacy.delete.irreversible')}</p>
        </div>
      </ConfirmDialog>
    </>
  );
}

function CloudDisclosurePanel() {
  const { t } = useI18n();
  const settings = useSettings();
  const editable = useEditable();
  const { pending, savedAt, save } = useImmediateSave();
  const [reviewing, setReviewing] = useState(false);
  if (!settings) return null;
  const acknowledged = settings.privacy.cloudDisclosureAcknowledged;
  const cloudProviders = settings.ai.providers.filter((p) => p.enabled && p.cloud);
  const active = settings.ai.providers.find((p) => p.id === settings.ai.activeProviderId);

  return (
    <Panel
      icon={<Cloud />}
      title={t('settings.privacy.cloud.title')}
      description={t('settings.privacy.cloud.description')}
      actions={<SavedIndicator at={savedAt} />}
    >
      <Rows>
        <SettingRow
          label={t('settings.privacy.cloud.status')}
          description={active ? (active.cloud ? t('settings.privacy.cloud.activeCloud', { provider: active.label }) : t('settings.privacy.cloud.activeLocal', { provider: active.label })) : null}
        >
          <StatusChip
            tone={acknowledged ? 'success' : 'warning'}
            label={acknowledged ? t('settings.privacy.cloud.acknowledged') : t('settings.privacy.cloud.notAcknowledged')}
          />
        </SettingRow>
        <SettingRow label={t('settings.privacy.cloud.providers')} description={cloudProviders.length === 0 ? t('settings.privacy.cloud.none') : null}>
          <div className="flex flex-wrap gap-1.5">
            {cloudProviders.map((p) => (
              <StatusChip key={p.id} size="sm" tone="default" icon={<Cloud />} hideDot label={p.label} />
            ))}
          </div>
        </SettingRow>
      </Rows>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onPress={() => setReviewing(true)}>
          {t('settings.privacy.cloud.review')}
        </Button>
        {acknowledged ? (
          <Button
            size="sm"
            variant="ghost"
            isDisabled={!editable}
            isPending={pending === 'disclosure'}
            onPress={() => void save('disclosure', { privacy: { cloudDisclosureAcknowledged: false } })}
          >
            {t('settings.privacy.cloud.reshow')}
          </Button>
        ) : null}
      </div>
      <ConfirmDialog
        isOpen={reviewing}
        onOpenChange={setReviewing}
        title={t('settings.privacy.cloud.dialogTitle')}
        confirmLabel={acknowledged ? t('common.close') : t('settings.privacy.cloud.understand')}
        tone="ai"
        icon={<Cloud />}
        size="md"
        isConfirmDisabled={!acknowledged && !editable}
        onConfirm={async () => {
          if (!acknowledged) await save('disclosure', { privacy: { cloudDisclosureAcknowledged: true } }, { rethrow: true });
        }}
      >
        <div className="flex flex-col gap-2 text-start">
          <p className="text-foreground">{t('settings.privacy.cloud.body1')}</p>
          <p>{t('settings.privacy.cloud.body2')}</p>
          <p>{t('settings.privacy.cloud.body3')}</p>
        </div>
      </ConfirmDialog>
    </Panel>
  );
}

export function PrivacySection() {
  const { t } = useI18n();
  const access = useSectionAccess('local');
  const form = useSectionForm('privacy', ['cloudDisclosureAcknowledged']);
  const draft = form.draft;
  if (!draft) return null;

  return (
    <SectionFrame title={t('settings.privacy.title')} description={t('settings.privacy.description')} icon={<EyeSlash />} access={access}>
      <Panel title={t('settings.privacy.storage.title')} description={t('settings.privacy.storage.description')}>
        <Rows>
          <SwitchRow
            label={t('settings.privacy.screenshots.label')}
            description={t('settings.privacy.screenshots.description')}
            isSelected={draft.storeScreenshots}
            onChange={(v) => form.set('storeScreenshots', v)}
          />
          <NumberRow
            label={t('settings.privacy.screenshotRetention.label')}
            description={t('settings.privacy.screenshotRetention.description')}
            value={draft.screenshotRetentionDays}
            onChange={(v) => form.set('screenshotRetentionDays', v ?? Number.NaN)}
            minValue={1}
            maxValue={365}
            unit={t('settings.unit.days')}
            isDisabled={!draft.storeScreenshots}
            error={errorFor(form.errors, 'screenshotRetentionDays')}
          />
          <SwitchRow
            label={t('settings.privacy.typedText.label')}
            description={t('settings.privacy.typedText.description')}
            isSelected={draft.logTypedText}
            onChange={(v) => form.set('logTypedText', v)}
          />
          <NumberRow
            label={t('settings.privacy.history.label')}
            description={t('settings.privacy.history.description')}
            value={draft.historyRetentionDays}
            onChange={(v) => form.set('historyRetentionDays', v ?? Number.NaN)}
            minValue={1}
            maxValue={3650}
            unit={t('settings.unit.days')}
            error={errorFor(form.errors, 'historyRetentionDays')}
          />
        </Rows>
        {draft.logTypedText ? (
          <Notice tone="warning" icon={<TriangleExclamationFill />} className="mt-3">
            {t('settings.privacy.typedText.warning')}
          </Notice>
        ) : null}
      </Panel>

      <CloudDisclosurePanel />

      <Panel tone="danger" icon={<TrashBin />} title={t('settings.privacy.delete.panelTitle')} description={t('settings.privacy.delete.panelDescription')}>
        <DeleteDataButton />
      </Panel>

      <SaveBar dirty={form.dirty} status={form.status} error={form.generalError} onSave={() => void form.save()} onDiscard={form.discard} />
    </SectionFrame>
  );
}
