// Large view of a screenshot captured by a workflow step.

import { Picture } from '@gravity-ui/icons';
import { Button, Modal } from '@heroui/react';
import { useEffect, useState } from 'react';

import { EmptyState } from '../../components/EmptyState';
import { api } from '../../lib/api';
import { useI18n } from '../../lib/i18n';

export interface ScreenshotRef {
  id: string;
  title: string;
}

export function ScreenshotModal({ shot, onClose }: { shot: ScreenshotRef | null; onClose: () => void }) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  // Keep showing the last screenshot while the modal animates closed.
  const [last, setLast] = useState<ScreenshotRef | null>(shot);
  if (shot && shot !== last) setLast(shot);
  const shown = shot ?? last;
  useEffect(() => setFailed(false), [shot?.id]);
  return (
    <Modal.Backdrop isOpen={shot !== null} onOpenChange={(open) => !open && onClose()} variant="blur">
      <Modal.Container size="lg" placement="center">
        <Modal.Dialog className="app-panel bg-overlay">
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading className="flex items-center gap-2 text-base" dir="auto">
              <Picture className="size-4 text-muted" />
              {shown?.title ?? ''}
            </Modal.Heading>
          </Modal.Header>
          <Modal.Body className="flex justify-center">
            {shown && !failed ? (
              <img
                src={api.screen.screenshotUrl(shown.id)}
                alt={t('automations.run.screenshotAlt', { title: shown.title })}
                className="max-h-[70vh] w-auto rounded-xl bg-black object-contain"
                onError={() => setFailed(true)}
              />
            ) : (
              <EmptyState size="sm" icon={<Picture />} title={t('steps.screenshotGone.title')} description={t('steps.screenshotGone.body')} />
            )}
          </Modal.Body>
          <Modal.Footer className="flex justify-end">
            <Button variant="secondary" slot="close">
              {t('common.close')}
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

/** Clickable thumbnail that opens the screenshot modal. */
export function ScreenshotThumb({ id, title, onOpen, className }: { id: string; title: string; onOpen: (shot: ScreenshotRef) => void; className?: string }) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      onClick={() => onOpen({ id, title })}
      aria-label={t('automations.run.openScreenshot', { title })}
      className={[
        'app-transition block overflow-hidden rounded-lg border border-hairline hover:border-hairline-strong focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none',
        className ?? '',
      ].join(' ')}
    >
      {failed ? (
        <span className="flex h-20 w-14 items-center justify-center bg-default text-muted">
          <Picture className="size-4" />
        </span>
      ) : (
        <img
          src={api.screen.screenshotUrl(id)}
          alt={t('automations.run.screenshotAlt', { title })}
          loading="lazy"
          onError={() => setFailed(true)}
          className="h-24 w-auto bg-black object-contain"
        />
      )}
    </button>
  );
}
