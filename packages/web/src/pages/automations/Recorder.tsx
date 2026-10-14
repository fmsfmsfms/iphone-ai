// Manual recording: start (with a name), a status banner while recording,
// and Stop & save / Discard. Recording captures the manual actions performed
// in Live Control (GET/POST /api/recorder).

import { CircleFill, Smartphone, TriangleExclamation } from '@gravity-ui/icons';
import type { Workflow } from '@iphone-ai/shared';
import { Button, Modal } from '@heroui/react';
import { useCallback, useEffect, useState } from 'react';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { RelativeTime } from '../../components/RelativeTime';
import { api, errorMessage, type RecorderStatus } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { notify, notifyError, useAppStore, useCanControl } from '../../state/store';
import { Notice, TextInput } from './fields';

const POLL_MS = 2000;

export interface RecorderApi {
  status: RecorderStatus | null;
  error: string | null;
  refresh: () => Promise<void>;
  start: (name: string) => Promise<void>;
  /** Resolves with the saved workflow (null when discarded or nothing was recorded). */
  stop: (save: boolean) => Promise<Workflow | null>;
}

export function useRecorder(): RecorderApi {
  const [status, setStatus] = useState<RecorderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.recorder.status());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const recording = status?.recording ?? false;
  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [recording, refresh]);

  const start = useCallback(async (name: string) => {
    setStatus(await api.recorder.start(name));
  }, []);

  const stop = useCallback(
    async (save: boolean) => {
      const workflow = await api.recorder.stop(save);
      await refresh();
      return workflow ?? null;
    },
    [refresh],
  );

  return { status, error, refresh, start, stop };
}

/** Dialog that names and starts a recording. */
export function StartRecordingDialog({ isOpen, onOpenChange, recorder }: { isOpen: boolean; onOpenChange: (open: boolean) => void; recorder: RecorderApi }) {
  const { t } = useI18n();
  const manualEnabled = useAppStore((s) => s.settings?.permissions.manualControlEnabled ?? false);
  const [name, setName] = useState('');
  const [pending, setPending] = useState<'stay' | 'live' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) setError(null);
  }, [isOpen]);

  const start = async (openLive: boolean) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setPending(openLive ? 'live' : 'stay');
    setError(null);
    try {
      await recorder.start(trimmed);
      onOpenChange(false);
      setName('');
      if (openLive) navigate({ name: 'live' });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(null);
    }
  };

  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={(open) => pending === null && onOpenChange(open)} variant="blur">
      <Modal.Container size="md" placement="center">
        <Modal.Dialog className="app-panel bg-overlay">
          <Modal.CloseTrigger />
          <Modal.Header className="flex flex-row items-center gap-3">
            <Modal.Icon className="bg-danger/15 text-danger [&>svg]:size-4">
              <CircleFill />
            </Modal.Icon>
            <Modal.Heading className="text-base font-semibold">{t('automations.recorder.startTitle')}</Modal.Heading>
          </Modal.Header>
          <Modal.Body className="flex flex-col gap-3 text-[13px] leading-relaxed text-muted">
            <p>{t('automations.recorder.explain')}</p>
            <ul className="space-y-1.5 text-xs">
              {[1, 2, 3].map((n) => (
                <li key={n} className="flex gap-2">
                  <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-muted" />
                  {t(`automations.recorder.point${n}`)}
                </li>
              ))}
            </ul>
            {!manualEnabled ? (
              <Notice tone="warning" icon={<TriangleExclamation />}>
                {t('automations.recorder.manualOff')}
              </Notice>
            ) : null}
            <TextInput
              label={t('automations.recorder.name')}
              value={name}
              onChange={setName}
              placeholder={t('automations.recorder.namePlaceholder')}
              maxLength={120}
              autoFocus
              isRequired
            />
            {error ? (
              <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-danger">
                {error}
              </p>
            ) : null}
          </Modal.Body>
          <Modal.Footer className="flex flex-wrap justify-end gap-2">
            <Button variant="tertiary" onPress={() => onOpenChange(false)} isDisabled={pending !== null}>
              {t('common.cancel')}
            </Button>
            <Button variant="secondary" isPending={pending === 'stay'} isDisabled={!name.trim() || pending !== null} onPress={() => void start(false)}>
              {t('automations.recorder.start')}
            </Button>
            <Button variant="primary" isPending={pending === 'live'} isDisabled={!name.trim() || pending !== null} onPress={() => void start(true)}>
              <Smartphone className="size-3.5" />
              {t('automations.recorder.startAndOpen')}
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

/** Banner shown while a recording is in progress. */
export function RecorderBanner({ recorder, onSaved }: { recorder: RecorderApi; onSaved: (workflow: Workflow) => void }) {
  const { t } = useI18n();
  const canControl = useCanControl();
  const manualEnabled = useAppStore((s) => s.settings?.permissions.manualControlEnabled ?? false);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const status = recorder.status;
  if (!status?.recording) return null;

  const save = async () => {
    setSaving(true);
    try {
      const workflow = await recorder.stop(true);
      if (workflow) {
        notify('success', t('automations.recorder.saved', { name: workflow.name }));
        onSaved(workflow);
      } else {
        notify('info', t('automations.recorder.nothing'));
      }
    } catch (err) {
      notifyError(t('automations.recorder.stopFailed'), err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div role="status" className="app-glass flex flex-wrap items-center gap-3 rounded-2xl border border-danger/35 p-3 ps-4">
      <span aria-hidden className="relative flex size-3 shrink-0">
        <span className="absolute inset-0 animate-ping rounded-full bg-danger/60" />
        <span className="relative size-3 rounded-full bg-danger" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-foreground">
          {t('automations.recorder.recording', { name: status.name ?? '' })}
        </p>
        <p className="text-xs text-muted">
          {t('automations.recorder.progress', { count: status.steps })}
          {status.startedAt ? (
            <>
              {' · '}
              {t('automations.recorder.started')} <RelativeTime at={status.startedAt} />
            </>
          ) : null}
        </p>
        <p className="mt-0.5 text-xs text-muted">{manualEnabled ? t('automations.recorder.hint') : t('automations.recorder.manualOff')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" onPress={() => navigate({ name: 'live' })}>
          <Smartphone className="size-3.5" />
          {t('automations.recorder.openLive')}
        </Button>
        {canControl ? (
          <>
            <Button size="sm" variant="ghost" className="text-danger" isDisabled={saving} onPress={() => setConfirmDiscard(true)}>
              {t('automations.recorder.discard')}
            </Button>
            <Button size="sm" variant="primary" isPending={saving} onPress={() => void save()}>
              {t('automations.recorder.stopSave')}
            </Button>
          </>
        ) : null}
      </div>
      <ConfirmDialog
        isOpen={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        tone="danger"
        icon={<TriangleExclamation />}
        title={t('automations.recorder.discardTitle')}
        confirmLabel={t('automations.recorder.discard')}
        onConfirm={async () => {
          await recorder.stop(false);
        }}
      >
        {t('automations.recorder.discardBody', { count: status.steps })}
      </ConfirmDialog>
    </div>
  );
}
