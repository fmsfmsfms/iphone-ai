// General: appearance, language, notifications and launch behaviour. Every
// change here is saved immediately.

import { ArrowRotateLeft, Display, Globe, Moon, Sliders, Sun } from '@gravity-ui/icons';
import type { Language, ThemePreference } from '@iphone-ai/shared';
import { Button } from '@heroui/react';
import { useState } from 'react';

import { Panel } from '../../components/Panel';
import { useI18n } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { notifyError, updateSettings, useSettings } from '../../state/store';
import { Rows, Segmented, SettingRow, SwitchRow, useEditable } from './fields';
import { SectionFrame, useSectionAccess } from './SectionFrame';
import { SavedIndicator, useImmediateSave } from './useImmediateSave';

function RestartOnboarding() {
  const { t } = useI18n();
  const editable = useEditable();
  const [pending, setPending] = useState(false);
  const restart = async () => {
    setPending(true);
    try {
      await updateSettings({ general: { onboardingCompleted: false } });
      navigate({ name: 'dashboard' });
    } catch (err) {
      notifyError(t('settings.general.onboarding.failed'), err);
    } finally {
      setPending(false);
    }
  };
  return (
    <Button size="sm" variant="secondary" isDisabled={!editable} isPending={pending} onPress={() => void restart()}>
      {pending ? null : <ArrowRotateLeft className="size-3.5" />}
      {t('settings.general.onboarding.button')}
    </Button>
  );
}

export function GeneralSection() {
  const { t } = useI18n();
  const settings = useSettings();
  const access = useSectionAccess('general');
  const { pending, savedAt, save } = useImmediateSave();
  if (!settings) return null;
  const general = settings.general;

  return (
    <SectionFrame
      title={t('settings.general.title')}
      description={t('settings.general.description')}
      icon={<Sliders />}
      access={access}
      actions={<SavedIndicator at={savedAt} />}
    >
      <Panel title={t('settings.general.appearance')}>
        <Rows>
          <SettingRow label={t('settings.general.theme.label')} description={t('settings.general.theme.description')}>
            <Segmented
              label={t('settings.general.theme.label')}
              value={general.theme}
              isDisabled={pending === 'theme'}
              onChange={(theme) => void save('theme', { general: { theme: theme as ThemePreference } })}
              options={[
                { id: 'dark', label: t('settings.general.theme.dark'), icon: <Moon /> },
                { id: 'light', label: t('settings.general.theme.light'), icon: <Sun /> },
                { id: 'system', label: t('settings.general.theme.system'), icon: <Display /> },
              ]}
            />
          </SettingRow>
          <SettingRow label={t('settings.general.language.label')} description={t('settings.general.language.description')}>
            <Segmented
              label={t('settings.general.language.label')}
              value={general.language}
              isDisabled={pending === 'language'}
              onChange={(language) => void save('language', { general: { language: language as Language } })}
              options={[
                { id: 'en', label: 'English', icon: <Globe /> },
                { id: 'ar', label: 'العربية', icon: <Globe /> },
              ]}
            />
          </SettingRow>
        </Rows>
      </Panel>

      <Panel title={t('settings.general.behavior')}>
        <Rows>
          <SwitchRow
            label={t('settings.general.notifications.label')}
            description={t('settings.general.notifications.description')}
            isSelected={general.notifications}
            isPending={pending === 'notifications'}
            onChange={(notifications) => void save('notifications', { general: { notifications } })}
          />
          <SwitchRow
            label={t('settings.general.openMirroring.label')}
            description={t('settings.general.openMirroring.description')}
            isSelected={general.openMirroringOnLaunch}
            isPending={pending === 'openMirroringOnLaunch'}
            onChange={(openMirroringOnLaunch) => void save('openMirroringOnLaunch', { general: { openMirroringOnLaunch } })}
          />
          <SwitchRow
            label={t('settings.general.refocus.label')}
            description={t('settings.general.refocus.description')}
            isSelected={general.refocusAfterManualAction}
            isPending={pending === 'refocusAfterManualAction'}
            onChange={(refocusAfterManualAction) => void save('refocusAfterManualAction', { general: { refocusAfterManualAction } })}
          />
        </Rows>
      </Panel>

      <Panel title={t('settings.general.onboarding.title')}>
        <SettingRow label={t('settings.general.onboarding.label')} description={t('settings.general.onboarding.description')}>
          <RestartOnboarding />
        </SettingRow>
      </Panel>
    </SectionFrame>
  );
}
