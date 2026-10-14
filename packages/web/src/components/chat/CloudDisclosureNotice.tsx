// The privacy notice shown before the first task with a cloud AI provider:
// what leaves this Mac, an "I understand" button (stored as
// privacy.cloudDisclosureAcknowledged) and a shortcut to choose a local
// model. Used above every composer that starts AI tasks (the AI Assistant
// page and Live Control's assistant panel); renders nothing when no notice is
// needed. Accepting is a privacy setting, which only the Mac may change.

import { Cloud, Gear } from '@gravity-ui/icons';
import { Button } from '@heroui/react';
import { useState } from 'react';

import { needsCloudDisclosure, providerReadiness } from '../../lib/device-state';
import { useI18n } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { notifyError, updateSettings, useAppStore, useCanControl, useIsLocal } from '../../state/store';

export interface CloudDisclosureNoticeProps {
  compact?: boolean;
  className?: string;
}

export function CloudDisclosureNotice({ compact, className }: CloudDisclosureNoticeProps) {
  const { t } = useI18n();
  const settings = useAppStore((s) => s.settings);
  const canControl = useCanControl();
  const isLocal = useIsLocal();
  const [acknowledging, setAcknowledging] = useState(false);
  const provider = providerReadiness(settings).provider;
  // View-only sessions can't send anything, so there is nothing to acknowledge.
  if (!provider || !canControl || !needsCloudDisclosure(settings, provider)) return null;

  const acknowledge = async () => {
    setAcknowledging(true);
    try {
      await updateSettings({ privacy: { cloudDisclosureAcknowledged: true } });
    } catch (err) {
      notifyError(t('common.saveFailed'), err);
    } finally {
      setAcknowledging(false);
    }
  };

  return (
    <div role="note" className={['ai-soft-bg rounded-2xl border border-hairline', compact ? 'p-3' : 'p-4', className ?? ''].join(' ')}>
      <div className="flex items-start gap-3">
        <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-background/60 text-ai-blue [&>svg]:size-4">
          <Cloud />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-foreground">{t('chat.disclosure.title', { provider: provider.label })}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted">{t('chat.disclosure.body', { provider: provider.label })}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted">{t('chat.disclosure.body2')}</p>
          {isLocal ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="primary" isPending={acknowledging} onPress={() => void acknowledge()}>
                {t('chat.disclosure.accept')}
              </Button>
              <Button size="sm" variant="ghost" onPress={() => navigate({ name: 'settings', section: 'ai' })}>
                <Gear className="size-3.5" />
                {t('chat.disclosure.local')}
              </Button>
            </div>
          ) : (
            <p className="mt-2 text-xs leading-relaxed font-medium text-foreground/90">{t('chat.disclosure.localOnly')}</p>
          )}
        </div>
      </div>
    </div>
  );
}
