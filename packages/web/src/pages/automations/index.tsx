// Automations: saved workflows, the editor, AI suggestions, manual recording
// and runs. Routes: #/automations (list), #/automations/new (unsaved draft),
// #/automations/<workflowId> (editor + runs).

import './messages';

import type { Workflow, WorkflowRunStatus, WorkflowSuggestion } from '@iphone-ai/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api, errorMessage } from '../../lib/api';
import { navigate } from '../../lib/router';
import { shallowEqual, useAppStore } from '../../state/store';
import { StartRecordingDialog, useRecorder } from './Recorder';
import { SuggestDialog } from './SuggestDialog';
import { clearNewDraft, NEW_WORKFLOW_ID, WorkflowDetail } from './WorkflowDetail';
import { WorkflowList } from './WorkflowList';
import { draftFromSuggestion, LIVE_RUN_STATUSES, sortWorkflows, type WorkflowDraft } from './workflow-utils';

export default function AutomationsPage({ workflowId }: { workflowId?: string }) {
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [seed, setSeed] = useState<WorkflowDraft | null>(null);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [recordOpen, setRecordOpen] = useState(false);
  const recorder = useRecorder();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setWorkflows(sortWorkflows(await api.workflows.list()));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Last-run fields change when a run finishes: refresh the list then.
  const runStates = useAppStore((s) => Object.values(s.workflowRuns).map((r) => `${r.id}:${r.status}`), shallowEqual);
  const liveRuns = useRef(new Set<string>());
  useEffect(() => {
    let finished = false;
    for (const entry of runStates) {
      const split = entry.lastIndexOf(':');
      const id = entry.slice(0, split);
      const status = entry.slice(split + 1) as WorkflowRunStatus;
      if (LIVE_RUN_STATUSES.includes(status)) liveRuns.current.add(id);
      else if (liveRuns.current.delete(id)) finished = true;
    }
    if (finished) void load();
  }, [runStates, load]);

  const startNew = () => {
    clearNewDraft();
    setSeed(null);
    navigate({ name: 'automations', workflowId: NEW_WORKFLOW_ID });
  };

  const applySuggestion = (suggestion: WorkflowSuggestion) => {
    clearNewDraft();
    setSeed(draftFromSuggestion(suggestion));
    navigate({ name: 'automations', workflowId: NEW_WORKFLOW_ID });
  };

  const onRecordingSaved = (workflow: Workflow) => {
    void load();
    navigate({ name: 'automations', workflowId: workflow.id });
  };

  return (
    <>
      {workflowId ? (
        <WorkflowDetail
          key={workflowId}
          workflowId={workflowId}
          seed={workflowId === NEW_WORKFLOW_ID ? seed : null}
          onListChanged={() => void load()}
          recorder={recorder}
          onRecordingSaved={onRecordingSaved}
        />
      ) : (
        <WorkflowList
          workflows={workflows}
          loading={loading}
          error={error}
          onReload={() => void load()}
          onNew={startNew}
          onSuggest={() => setSuggestOpen(true)}
          onRecord={() => setRecordOpen(true)}
          recorder={recorder}
          onRecordingSaved={onRecordingSaved}
        />
      )}
      <SuggestDialog isOpen={suggestOpen} onOpenChange={setSuggestOpen} onUse={applySuggestion} />
      <StartRecordingDialog isOpen={recordOpen} onOpenChange={setRecordOpen} recorder={recorder} />
    </>
  );
}
