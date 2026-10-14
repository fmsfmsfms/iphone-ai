// Draft state for one settings section. Edits stay local until Save, which
// sends only the changed keys (PUT /api/settings { [section]: patch }).
// Server-side changes (WebSocket `settings` events, other windows) are merged
// into the draft without overwriting the user's own edits.

import type { AppSettings } from '@iphone-ai/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { errorMessage, isApiError } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { updateSettings, useAppStore } from '../../state/store';
import { diffSection, parseServerValidation, rebaseDraft, validateSectionPatch, type EditableSection, type FieldErrors } from './helpers';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface SectionForm<K extends EditableSection> {
  /** Current draft (null until settings are loaded). */
  draft: AppSettings[K] | null;
  /** Last known server values. */
  saved: AppSettings[K] | null;
  set: <F extends keyof AppSettings[K]>(field: F, value: AppSettings[K][F]) => void;
  update: (fn: (draft: AppSettings[K]) => AppSettings[K]) => void;
  dirty: boolean;
  /** Changed keys that would be sent on save. */
  patch: Partial<AppSettings[K]>;
  /** Client-side and server-side field errors (paths inside the section). */
  errors: FieldErrors;
  generalError: string | null;
  status: SaveStatus;
  save: () => Promise<boolean>;
  discard: () => void;
}

interface FormState<T> {
  base: T | null;
  draft: T | null;
}

const SAVED_VISIBLE_MS = 2500;

export function useSectionForm<K extends EditableSection>(section: K, ignore: readonly (keyof AppSettings[K])[] = []): SectionForm<K> {
  type Values = AppSettings[K];
  const { t } = useI18n();
  const server = useAppStore((s) => (s.settings ? s.settings[section] : null)) as Values | null;
  const [form, setForm] = useState<FormState<Values>>({ base: server, draft: server });
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [generalError, setGeneralError] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stable identity for the ignore list (callers usually pass an inline array).
  const ignoreKey = ignore.map(String).join(',');
  const ignored = useMemo(() => (ignoreKey ? (ignoreKey.split(',') as (keyof Values)[]) : []), [ignoreKey]);

  // Merge server updates into the draft, keeping the user's own edits.
  useEffect(() => {
    if (!server) return;
    setForm((f) => (f.base && f.draft ? { base: server, draft: rebaseDraft(f.base, f.draft, server, ignored) } : { base: server, draft: server }));
  }, [server, ignored]);

  useEffect(
    () => () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    },
    [],
  );

  const patch = useMemo<Partial<Values>>(() => (form.base && form.draft ? diffSection(form.base, form.draft, ignored) : {}), [form, ignored]);
  const dirty = Object.keys(patch).length > 0;
  const clientErrors = useMemo(() => validateSectionPatch(section, patch, t), [section, patch, t]);
  const errors = useMemo(() => ({ ...serverErrors, ...clientErrors }), [serverErrors, clientErrors]);

  const touch = useCallback(() => {
    setServerErrors({});
    setGeneralError(null);
    setStatus((s) => (s === 'saved' || s === 'error' ? 'idle' : s));
  }, []);

  const set = useCallback(
    <F extends keyof Values>(field: F, value: Values[F]) => {
      touch();
      setForm((f) => (f.draft ? { ...f, draft: { ...f.draft, [field]: value } } : f));
    },
    [touch],
  );

  const update = useCallback(
    (fn: (draft: Values) => Values) => {
      touch();
      setForm((f) => (f.draft ? { ...f, draft: fn(f.draft) } : f));
    },
    [touch],
  );

  const save = useCallback(async (): Promise<boolean> => {
    if (!dirty) return true;
    if (Object.keys(clientErrors).length > 0) {
      setStatus('error');
      setGeneralError(t('settings.save.fixErrors'));
      return false;
    }
    setStatus('saving');
    setServerErrors({});
    setGeneralError(null);
    try {
      await updateSettings({ [section]: patch });
      setStatus('saved');
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setStatus((s) => (s === 'saved' ? 'idle' : s)), SAVED_VISIBLE_MS);
      return true;
    } catch (err) {
      setStatus('error');
      if (isApiError(err) && err.code === 'validation_error') {
        const parsed = parseServerValidation(err.message, section);
        setServerErrors(parsed.fields);
        setGeneralError(parsed.general ?? (Object.keys(parsed.fields).length ? t('settings.save.fixErrors') : err.message));
      } else {
        setGeneralError(errorMessage(err));
      }
      return false;
    }
  }, [dirty, clientErrors, patch, section, t]);

  const discard = useCallback(() => {
    setForm((f) => ({ ...f, draft: f.base }));
    setServerErrors({});
    setGeneralError(null);
    setStatus('idle');
  }, []);

  return { draft: form.draft, saved: form.base, set, update, dirty, patch, errors, generalError, status, save, discard };
}
