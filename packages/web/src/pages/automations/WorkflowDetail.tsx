// One workflow: editor (left) and run controls / live run / history (right).
// Unsaved edits survive navigating away and back (kept in memory per
// workflow until saved or discarded).

import { ArrowLeft, ArrowUturnCcwLeft, FileArrowDown, FloppyDisk, Thunderbolt, TrashBin, TriangleExclamation } from '@gravity-ui/icons';
import type { Workflow } from '@iphone-ai/shared';
import { Button, Spinner } from '@heroui/react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/EmptyState';
import { KbdHint } from '../../components/KbdHint';
import { Page } from '../../components/Page';
import { Panel } from '../../components/Panel';
import { RelativeTime } from '../../components/RelativeTime';
import { StatusChip } from '../../components/StatusChip';
import { api, errorMessage, isApiError } from '../../lib/api';
import { hasMod, useWindowKeydown } from '../../lib/hotkeys';
import { useI18n } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { notify, notifyError, useCanControl } from '../../state/store';
import { Notice } from './fields';
import { ExportDialog } from './ExportDialog';
import { RecorderBanner, type RecorderApi } from './Recorder';
import { RunPanel } from './RunPanel';
import { SourceBadge } from './SourceBadge';
import { WorkflowEditor } from './WorkflowEditor';
import { draftFromWorkflow, emptyDraft, isDraftDirty, toWorkflowInput, validateDraft, type WorkflowDraft } from './workflow-utils';

export const NEW_WORKFLOW_ID = 'new';

/** Unsaved drafts by workflow id (NEW_WORKFLOW_ID for a workflow that doesn't exist yet). */
const draftCache = new Map<string, WorkflowDraft>();

/** Forgets the unsaved new-workflow draft (when the user explicitly starts another one). */
export function clearNewDraft(): void {
  draftCache.delete(NEW_WORKFLOW_ID);
}

export interface WorkflowDetailProps {
  workflowId: string;
  /** Initial draft for a new workflow (e.g. from an AI suggestion). */
  seed?: WorkflowDraft | null;
  onListChanged?: () => void;
  recorder: RecorderApi;
  onRecordingSaved: (workflow: Workflow) => void;
}

export function WorkflowDetail({ workflowId, seed, onListChanged, recorder, onRecordingSaved }: WorkflowDetailProps) {
  const { t } = useI18n();
  const canControl = useCanControl();
  const isNew = workflowId === NEW_WORKFLOW_ID;
  const [saved, setSaved] = useState<Workflow | null>(null);
  const [draft, setDraftState] = useState<WorkflowDraft | null>(() => {
    if (isNew) return seed ?? draftCache.get(NEW_WORKFLOW_ID) ?? emptyDraft();
    return draftCache.get(workflowId) ?? null;
  });
  const [restored, setRestored] = useState(() => !isNew && draftCache.has(workflowId));
  const [loading, setLoading] = useState(!isNew);
  const [loadError, setLoadError] = useState<{ message: string; notFound: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [showAllErrors, setShowAllErrors] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  const setDraft = useCallback(
    (next: WorkflowDraft) => {
      setDraftState(next);
      draftCache.set(workflowId, next);
    },
    [workflowId],
  );

  const load = useCallback(async () => {
    if (isNew) return;
    setLoading(true);
    setLoadError(null);
    try {
      const workflow = await api.workflows.get(workflowId);
      setSaved(workflow);
      setDraftState((current) => current ?? draftFromWorkflow(workflow));
    } catch (err) {
      setLoadError({ message: errorMessage(err), notFound: isApiError(err) && err.status === 404 });
    } finally {
      setLoading(false);
    }
  }, [isNew, workflowId]);

  useEffect(() => {
    void load();
  }, [load]);

  // A seed from an AI suggestion replaces an empty new draft.
  useEffect(() => {
    if (isNew && seed) {
      setDraftState(seed);
      draftCache.set(NEW_WORKFLOW_ID, seed);
    }
  }, [isNew, seed]);

  /** Re-reads the workflow's run fields without touching the draft. */
  const refreshSaved = useCallback(async () => {
    if (isNew) return;
    try {
      setSaved(await api.workflows.get(workflowId));
      onListChanged?.();
    } catch {
      // The next explicit load shows any error.
    }
  }, [isNew, onListChanged, workflowId]);

  const savedDraft = useMemo(() => (saved ? draftFromWorkflow(saved) : null), [saved]);
  const dirty = draft ? isDraftDirty(draft, savedDraft) : false;
  const validation = useMemo(() => (draft ? validateDraft(draft) : null), [draft]);

  useEffect(() => {
    if (!dirty && !isNew) {
      draftCache.delete(workflowId);
      setRestored(false);
    }
  }, [dirty, isNew, workflowId]);

  const save = async () => {
    if (!draft || !validation) return;
    if (!validation.valid) {
      setShowAllErrors(true);
      notify('warning', t('automations.editor.fixErrors'), validation.invalidSteps > 0 ? t('automations.editor.invalidSteps', { count: validation.invalidSteps }) : undefined);
      return;
    }
    setSaving(true);
    try {
      const input = toWorkflowInput(draft);
      const workflow = isNew ? await api.workflows.create(input) : await api.workflows.update(workflowId, input);
      draftCache.delete(workflowId);
      setSaved(workflow);
      setDraftState(draftFromWorkflow(workflow));
      setShowAllErrors(false);
      notify('success', t('automations.editor.saved', { name: workflow.name }));
      onListChanged?.();
      if (isNew) navigate({ name: 'automations', workflowId: workflow.id }, { replace: true });
    } catch (err) {
      notifyError(t('automations.editor.saveFailed'), err);
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    draftCache.delete(workflowId);
    setRestored(false);
    setShowAllErrors(false);
    if (savedDraft) setDraftState(savedDraft);
    else setDraftState(emptyDraft());
  };

  const back = () => navigate({ name: 'automations' });

  useWindowKeydown((e) => {
    if (hasMod(e) && e.key.toLowerCase() === 's' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (canControl && dirty && !saving) void save();
    }
  });

  const title = isNew ? t('automations.newTitle') : (saved?.name ?? t('automations.title'));

  if (loading && !draft) {
    return (
      <Page title={t('automations.title')} icon={<Thunderbolt />}>
        <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-muted" role="status">
          <Spinner size="sm" />
          {t('automations.loadingWorkflow')}
        </div>
      </Page>
    );
  }

  if (loadError && !saved) {
    return (
      <Page title={t('automations.title')} icon={<Thunderbolt />}>
        <EmptyState
          tone={loadError.notFound ? 'default' : 'danger'}
          icon={<TriangleExclamation />}
          title={loadError.notFound ? t('automations.notFound.title') : t('automations.loadFailed')}
          description={loadError.notFound ? t('automations.notFound.body') : loadError.message}
          actions={
            <>
              <Button size="sm" variant="secondary" onPress={back}>
                <ArrowLeft className="size-3.5 rtl:rotate-180" />
                {t('automations.backToList')}
              </Button>
              {!loadError.notFound ? (
                <Button size="sm" variant="primary" onPress={() => void load()}>
                  {t('common.tryAgain')}
                </Button>
              ) : null}
            </>
          }
        />
      </Page>
    );
  }

  if (!draft || !validation) return null;

  return (
    <Page
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span dir="auto" className="min-w-0 truncate">
            {title}
          </span>
          {dirty ? <StatusChip tone="warning" size="sm" label={t('automations.editor.unsaved')} /> : null}
        </span>
      }
      icon={<Thunderbolt />}
      description={
        saved ? (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <SourceBadge source={saved.source} />
            <span>
              {t('automations.editor.updated')} <RelativeTime at={saved.updatedAt} />
            </span>
          </span>
        ) : (
          t('automations.newDescription')
        )
      }
      actions={
        <>
          <Button size="sm" variant="ghost" onPress={back}>
            <ArrowLeft className="size-3.5 rtl:rotate-180" />
            {t('automations.backToList')}
          </Button>
          {saved ? (
            <>
              <Button size="sm" variant="secondary" onPress={() => setExportOpen(true)}>
                <FileArrowDown className="size-3.5" />
                {t('automations.export.button')}
              </Button>
              <Button size="sm" variant="ghost" className="text-danger" isDisabled={!canControl} onPress={() => setConfirmDelete(true)}>
                <TrashBin className="size-3.5" />
                {t('automations.editor.delete')}
              </Button>
            </>
          ) : null}
          {dirty && (saved || draft.steps.length > 0 || draft.name) ? (
            <Button size="sm" variant="ghost" onPress={() => setConfirmDiscard(true)}>
              <ArrowUturnCcwLeft className="size-3.5" />
              {t('automations.editor.discard')}
            </Button>
          ) : null}
          <Button size="sm" variant="primary" isPending={saving} isDisabled={!canControl || !dirty || saving} onPress={() => void save()}>
            <FloppyDisk className="size-3.5" />
            {t('automations.editor.save')}
            <KbdHint keys={['mod', 'S']} light className="ms-1 hidden sm:inline-flex" />
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <RecorderBanner recorder={recorder} onSaved={onRecordingSaved} />
        {restored && dirty ? (
          <Notice tone="default" icon={<ArrowUturnCcwLeft />}>
            {t('automations.editor.restored')}
          </Notice>
        ) : null}
        {isNew && draft.source === 'ai-suggested' ? (
          <Notice tone="ai" icon={<Thunderbolt />}>
            {t('automations.editor.reviewSuggestion')}
          </Notice>
        ) : null}
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
          <div className="min-w-0">
            <WorkflowEditor draft={draft} onChange={setDraft} validation={validation} showAllErrors={showAllErrors} isDisabled={!canControl} />
          </div>
          <div className="flex min-w-0 flex-col gap-5">
            {saved ? (
              <RunPanel workflow={saved} dirty={dirty} onRunFinished={() => void refreshSaved()} />
            ) : (
              <Panel icon={<Thunderbolt />} title={t('automations.run.title')}>
                <p className="text-[13px] leading-relaxed text-muted">{t('automations.run.saveFirst')}</p>
                <p className="mt-3 rounded-xl bg-default/40 px-3 py-2 text-[11px] leading-relaxed text-muted">{t('automations.unattended')}</p>
              </Panel>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        isOpen={confirmDelete}
        onOpenChange={setConfirmDelete}
        tone="danger"
        icon={<TrashBin />}
        title={t('automations.editor.deleteTitle', { name: saved?.name ?? '' })}
        confirmLabel={t('automations.editor.delete')}
        onConfirm={async () => {
          await api.workflows.remove(workflowId);
          draftCache.delete(workflowId);
          notify('success', t('automations.editor.deleted', { name: saved?.name ?? '' }));
          onListChanged?.();
          navigate({ name: 'automations' }, { replace: true });
        }}
      >
        {t('automations.editor.deleteBody')}
      </ConfirmDialog>
      <ConfirmDialog
        isOpen={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        tone="warning"
        icon={<ArrowUturnCcwLeft />}
        title={t('automations.editor.discardTitle')}
        confirmLabel={t('automations.editor.discard')}
        onConfirm={discard}
      >
        {t('automations.editor.discardBody')}
      </ConfirmDialog>
      <ExportDialog workflowId={exportOpen && saved ? saved.id : null} dirty={dirty} onClose={() => setExportOpen(false)} />
    </Page>
  );
}
