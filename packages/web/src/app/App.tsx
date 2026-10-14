// Root component: language + theme, toasts, and the boot state machine
// (connecting → ready | session expired | backend unreachable).

import { Toast } from '@heroui/react';
import { useEffect } from 'react';

import { I18nRoot, type Language } from '../lib/i18n';
import { readJson, STORAGE_KEYS, writeJson } from '../lib/storage';
import { useAppStore } from '../state/store';
import { BackendUnreachable, SessionExpired, Splash } from './FullScreenStates';
import { Shell } from './Shell';
import { ThemeController, ToastBridge } from './Watchers';

export function App() {
  const boot = useAppStore((s) => s.boot);
  const settingsLanguage = useAppStore((s) => s.settings?.general.language ?? null);
  // Until settings arrive, use the last language this browser saw (avoids an English flash for Arabic users).
  const language: Language = settingsLanguage ?? (readJson<string>(STORAGE_KEYS.language, 'en') === 'ar' ? 'ar' : 'en');

  useEffect(() => {
    if (settingsLanguage) writeJson(STORAGE_KEYS.language, settingsLanguage);
  }, [settingsLanguage]);

  return (
    <I18nRoot language={language}>
      <ThemeController />
      <Toast.Provider placement="bottom end" maxVisibleToasts={4} />
      <ToastBridge />
      {boot === 'ready' ? <Shell /> : boot === 'unauthorized' ? <SessionExpired /> : boot === 'unreachable' ? <BackendUnreachable /> : <Splash />}
    </I18nRoot>
  );
}
