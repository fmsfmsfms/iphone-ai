// Explains that workflow runs need Assisted or AI Mode, with buttons
// that go through the standard mode-change confirmation.

import { Eye, Hand, Sparkles } from '@gravity-ui/icons';
import { Button } from '@heroui/react';

import { useModeChange } from '../../app/ControlModeSelector';
import { useI18n } from '../../lib/i18n';
import { useCanControl } from '../../state/store';
import { Notice } from './fields';

export function ModeNotice({ className }: { className?: string }) {
  const { t } = useI18n();
  const canControl = useCanControl();
  const { current, request, dialog } = useModeChange();
  if (current !== 'observe') return null;
  return (
    <>
      <Notice
        tone="warning"
        icon={<Eye />}
        title={t('automations.mode.title')}
        className={className}
        actions={
          canControl ? (
            <>
              <Button size="sm" variant="secondary" onPress={() => request('assisted')}>
                <Hand className="size-3.5" />
                {t('automations.mode.assisted')}
              </Button>
              <Button size="sm" variant="secondary" onPress={() => request('supervised')}>
                <Sparkles className="size-3.5" />
                {t('automations.mode.supervised')}
              </Button>
            </>
          ) : null
        }
      >
        {t('automations.mode.body')}
      </Notice>
      {dialog}
    </>
  );
}
