// Saves single settings changes immediately (switches and choices that need
// no Save button) and remembers when the last one succeeded.

import { Check } from '@gravity-ui/icons';
import type { SettingsPatch } from '@iphone-ai/shared';
import { useCallback, useEffect, useState } from 'react';

import { useI18n } from '../../lib/i18n';
import { notifyError, updateSettings } from '../../state/store';

export function useImmediateSave() {
  const { t } = useI18n();
  const [pending, setPending] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  /** Saves `patch`; failures show a toast, or are re-thrown with `rethrow` (for confirmation dialogs). */
  const save = useCallback(
    async (key: string, patch: SettingsPatch, options: { rethrow?: boolean } = {}): Promise<boolean> => {
      setPending(key);
      try {
        await updateSettings(patch);
        setSavedAt(Date.now());
        return true;
      } catch (err) {
        if (options.rethrow) throw err;
        notifyError(t('settings.save.failed'), err);
        return false;
      } finally {
        setPending((p) => (p === key ? null : p));
      }
    },
    [t],
  );

  return { pending, savedAt, save };
}

/** "Saved" tick shown for a moment after an immediate change. */
export function SavedIndicator({ at }: { at: number | null }) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!at) return;
    setVisible(true);
    const id = setTimeout(() => setVisible(false), 2500);
    return () => clearTimeout(id);
  }, [at]);
  return (
    <span
      aria-live="polite"
      className={['app-transition inline-flex items-center gap-1 text-xs font-medium text-success', visible ? 'opacity-100' : 'opacity-0'].join(' ')}
    >
      {visible ? (
        <>
          <Check aria-hidden className="size-3.5" />
          {t('settings.save.saved')}
        </>
      ) : null}
    </span>
  );
}
