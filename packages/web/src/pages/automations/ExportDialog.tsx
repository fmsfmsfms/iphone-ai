// Export a saved workflow as a Mirroir-compatible SKILL.md: shows where the
// file was written and a preview of the markdown.

import { Copy, FileArrowDown, TriangleExclamation } from '@gravity-ui/icons';
import { Button, Modal, Spinner } from '@heroui/react';
import { useEffect, useState } from 'react';

import { api, errorMessage, type ExportSkillResponse } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { notify } from '../../state/store';
import { Notice } from './fields';

export interface ExportDialogProps {
  workflowId: string | null;
  dirty: boolean;
  onClose: () => void;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function ExportDialog({ workflowId, dirty, onClose }: ExportDialogProps) {
  const { t } = useI18n();
  const [result, setResult] = useState<ExportSkillResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!workflowId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setResult(null);
    api.workflows
      .exportSkill(workflowId)
      .then((res) => {
        if (!cancelled) setResult(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workflowId, attempt]);

  const copy = async (text: string, what: 'path' | 'markdown') => {
    const ok = await copyText(text);
    notify(ok ? 'success' : 'error', ok ? t(`automations.export.copied.${what}`) : t('automations.export.copyFailed'));
  };

  return (
    <Modal.Backdrop isOpen={workflowId !== null} onOpenChange={(open) => !open && onClose()} variant="blur">
      <Modal.Container size="lg" placement="center" scroll="inside">
        <Modal.Dialog className="app-panel bg-overlay">
          <Modal.CloseTrigger />
          <Modal.Header className="flex flex-row items-center gap-3">
            <Modal.Icon className="bg-default text-foreground [&>svg]:size-5">
              <FileArrowDown />
            </Modal.Icon>
            <div>
              <Modal.Heading className="text-base font-semibold">{t('automations.export.title')}</Modal.Heading>
              <p className="text-xs text-muted">{t('automations.export.subtitle')}</p>
            </div>
          </Modal.Header>
          <Modal.Body className="flex flex-col gap-3">
            {dirty ? (
              <Notice tone="warning" icon={<TriangleExclamation />}>
                {t('automations.export.dirty')}
              </Notice>
            ) : null}
            {loading ? (
              <div className="flex items-center gap-2 py-6 text-xs text-muted" role="status">
                <Spinner size="sm" />
                {t('automations.export.loading')}
              </div>
            ) : error ? (
              <Notice
                tone="danger"
                icon={<TriangleExclamation />}
                title={t('automations.export.error')}
                actions={
                  <Button size="sm" variant="secondary" onPress={() => setAttempt((n) => n + 1)}>
                    {t('common.tryAgain')}
                  </Button>
                }
              >
                {error}
              </Notice>
            ) : result ? (
              <>
                <div className="flex flex-col gap-1.5">
                  <p className="text-xs font-medium text-muted">{t('automations.export.path')}</p>
                  <div className="flex items-center gap-2 rounded-xl border border-hairline bg-background/60 p-2 ps-3">
                    <code dir="ltr" className="min-w-0 flex-1 font-mono text-[12px] break-all text-foreground">
                      {result.path}
                    </code>
                    <Button size="sm" variant="ghost" isIconOnly aria-label={t('automations.export.copyPath')} onPress={() => void copy(result.path, 'path')}>
                      <Copy className="size-3.5" />
                    </Button>
                  </div>
                  <p className="text-[11px] leading-relaxed text-muted">{t('automations.export.pathHint')}</p>
                </div>
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium text-muted">{t('automations.export.preview')}</p>
                    <Button size="sm" variant="ghost" onPress={() => void copy(result.markdown, 'markdown')}>
                      <Copy className="size-3.5" />
                      {t('automations.export.copyMarkdown')}
                    </Button>
                  </div>
                  <pre dir="ltr" className="app-scroll max-h-[45vh] rounded-xl border border-hairline bg-background/60 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground/90 [overflow-wrap:anywhere]">
                    {result.markdown}
                  </pre>
                </div>
              </>
            ) : null}
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
