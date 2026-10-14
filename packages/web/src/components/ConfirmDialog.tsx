// Controlled confirmation dialog. `onConfirm` may be async: the confirm button
// shows a spinner and the dialog stays open (with the error) if it throws.

import { Button, Modal } from '@heroui/react';
import { useEffect, useState, type ReactNode } from 'react';

import { errorMessage } from '../lib/api';
import { useI18n } from '../lib/i18n';

export interface ConfirmDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'warning' | 'danger' | 'ai';
  icon?: ReactNode;
  onConfirm: () => void | Promise<void>;
  /** Disable the confirm button (e.g. until a checkbox is ticked). */
  isConfirmDisabled?: boolean;
  size?: 'xs' | 'sm' | 'md' | 'lg';
}

const ICON_TONE: Record<NonNullable<ConfirmDialogProps['tone']>, string> = {
  default: 'bg-default text-foreground',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-danger/15 text-danger',
  ai: 'ai-gradient-bg text-white',
};

export function ConfirmDialog({
  isOpen,
  onOpenChange,
  title,
  children,
  confirmLabel,
  cancelLabel,
  tone = 'default',
  icon,
  onConfirm,
  isConfirmDisabled,
  size = 'sm',
}: ConfirmDialogProps) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) setError(null);
  }, [isOpen]);

  const confirm = async () => {
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={(open) => !pending && onOpenChange(open)} variant="blur">
      <Modal.Container size={size} placement="center">
        <Modal.Dialog role="alertdialog" className="app-panel bg-overlay">
          <Modal.Header className="flex flex-row items-center gap-3">
            {icon ? (
              <Modal.Icon className={['shrink-0 [&>svg]:size-5', ICON_TONE[tone]].join(' ')}>{icon}</Modal.Icon>
            ) : null}
            <Modal.Heading className="text-base font-semibold">{title}</Modal.Heading>
          </Modal.Header>
          <Modal.Body className="text-[13px] leading-relaxed text-muted">
            {children}
            {error ? (
              <p role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-danger">
                {error}
              </p>
            ) : null}
          </Modal.Body>
          <Modal.Footer className="flex justify-end gap-2">
            <Button variant="tertiary" onPress={() => onOpenChange(false)} isDisabled={pending}>
              {cancelLabel ?? t('common.cancel')}
            </Button>
            <Button
              variant={tone === 'danger' ? 'danger' : 'primary'}
              onPress={() => void confirm()}
              isPending={pending}
              isDisabled={isConfirmDisabled}
              autoFocus
            >
              {confirmLabel ?? t('common.confirm')}
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
