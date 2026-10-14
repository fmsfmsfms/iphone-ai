// Workflow editor: name, description and the ordered step list (add, remove,
// duplicate, move up/down, per-type forms with validation).

import { ArrowDown, ArrowUp, ChevronDown, Copy, ListCheck, TrashBin, TriangleExclamation } from '@gravity-ui/icons';
import type { WorkflowStep, WorkflowStepType } from '@iphone-ai/shared';
import { useState } from 'react';

import { EmptyState } from '../../components/EmptyState';
import { IconButton } from '../../components/IconButton';
import { Panel } from '../../components/Panel';
import { StatusChip } from '../../components/StatusChip';
import { useI18n } from '../../lib/i18n';
import { appStore } from '../../state/store';
import { AddStepMenu } from './AddStepMenu';
import { Notice, TextInput } from './fields';
import { StepFields, StepTypeHint } from './StepFields';
import { StepIcon } from './StepIcon';
import { createStep, stepDescriptionKey, stepNameKey, summarizeStep, type StepIssue } from './step-meta';
import { duplicateStep, moveStep, removeAt, type DraftValidation, type WorkflowDraft } from './workflow-utils';

export interface WorkflowEditorProps {
  draft: WorkflowDraft;
  onChange: (draft: WorkflowDraft) => void;
  validation: DraftValidation;
  /** Show every error (after a save attempt); otherwise only for edited fields. */
  showAllErrors: boolean;
  isDisabled?: boolean;
}

export function WorkflowEditor({ draft, onChange, validation, showAllErrors, isDisabled }: WorkflowEditorProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const [nameTouched, setNameTouched] = useState(false);

  const setSteps = (steps: WorkflowStep[]) => onChange({ ...draft, steps });
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const add = (type: WorkflowStepType) => {
    const geometryId = appStore.getState().status?.mirroring.geometry?.geometryId ?? null;
    const step = createStep(type, undefined, { geometryId });
    setSteps([...draft.steps, step]);
    setExpanded((prev) => new Set(prev).add(step.id));
    setJustAdded(step.id);
  };

  const updateStep = (index: number, step: WorkflowStep) => {
    const next = draft.steps.slice();
    next[index] = step;
    setSteps(next);
    setTouched((prev) => (prev.has(step.id) ? prev : new Set(prev).add(step.id)));
  };

  const duplicate = (index: number) => {
    const next = duplicateStep(draft.steps, index);
    const copy = next[index + 1];
    setSteps(next);
    if (copy) setExpanded((prev) => new Set(prev).add(copy.id));
  };

  const nameError = (showAllErrors || nameTouched) && validation.name ? t(validation.name) : null;

  return (
    <div className="flex flex-col gap-5">
      <Panel title={t('automations.editor.details')}>
        <div className="flex flex-col gap-4">
          <TextInput
            label={t('automations.editor.name')}
            value={draft.name}
            onChange={(name) => {
              setNameTouched(true);
              onChange({ ...draft, name });
            }}
            error={nameError}
            placeholder={t('automations.editor.namePlaceholder')}
            maxLength={120}
            isRequired
            isDisabled={isDisabled}
          />
          <TextInput
            label={t('automations.editor.description')}
            value={draft.description}
            onChange={(description) => onChange({ ...draft, description })}
            placeholder={t('automations.editor.descriptionPlaceholder')}
            maxLength={2000}
            multiline
            rows={2}
            isDisabled={isDisabled}
          />
        </div>
      </Panel>

      <Panel
        title={t('automations.editor.steps', { count: draft.steps.length })}
        description={t('automations.editor.stepsHint')}
        actions={<AddStepMenu onAdd={add} isDisabled={isDisabled} />}
      >
        {validation.general && showAllErrors ? (
          <Notice tone="danger" icon={<TriangleExclamation />} className="mb-3">
            {t(validation.general)}
          </Notice>
        ) : null}
        {draft.steps.length === 0 ? (
          <EmptyState
            size="sm"
            icon={<ListCheck />}
            title={t('automations.editor.noSteps.title')}
            description={t('automations.editor.noSteps.body')}
            actions={<AddStepMenu onAdd={add} isDisabled={isDisabled} variant="primary" />}
          />
        ) : (
          <ol className="flex flex-col gap-2" aria-label={t('automations.editor.stepsLabel')}>
            {draft.steps.map((step, index) => (
              <StepCard
                key={step.id}
                step={step}
                index={index}
                total={draft.steps.length}
                expanded={expanded.has(step.id)}
                autoFocus={justAdded === step.id}
                issues={validation.steps[step.id] ?? []}
                showErrors={showAllErrors || touched.has(step.id)}
                isDisabled={isDisabled}
                onToggle={() => toggle(step.id)}
                onChange={(next) => updateStep(index, next)}
                onMove={(delta) => setSteps(moveStep(draft.steps, index, delta))}
                onDuplicate={() => duplicate(index)}
                onRemove={() => setSteps(removeAt(draft.steps, index))}
              />
            ))}
          </ol>
        )}
        {draft.steps.length > 0 ? (
          <div className="mt-3 flex justify-center">
            <AddStepMenu onAdd={add} isDisabled={isDisabled} variant="ghost" />
          </div>
        ) : null}
      </Panel>
    </div>
  );
}

interface StepCardProps {
  step: WorkflowStep;
  index: number;
  total: number;
  expanded: boolean;
  autoFocus: boolean;
  issues: StepIssue[];
  showErrors: boolean;
  isDisabled?: boolean;
  onToggle: () => void;
  onChange: (step: WorkflowStep) => void;
  onMove: (delta: -1 | 1) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}

function StepCard({ step, index, total, expanded, autoFocus, issues, showErrors, isDisabled, onToggle, onChange, onMove, onDuplicate, onRemove }: StepCardProps) {
  const { t, formatNumber } = useI18n();
  const invalid = issues.length > 0;
  const showInvalid = invalid && showErrors;
  const bodyId = `step-body-${step.id}`;

  return (
    <li
      className={[
        'app-transition rounded-2xl border bg-surface-secondary',
        showInvalid ? 'border-danger/45' : expanded ? 'border-hairline-strong' : 'border-hairline',
      ].join(' ')}
    >
      <div className="flex items-center gap-2 p-2 ps-2.5">
        <span className="w-6 shrink-0 text-center text-xs font-semibold text-muted tabular-nums" aria-hidden>
          {formatNumber(index + 1)}
        </span>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={bodyId}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-1 py-1 text-start outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <StepIcon type={step.type} />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-[13px] font-semibold text-foreground">{t(stepNameKey(step.type))}</span>
              {showInvalid ? <StatusChip tone="danger" size="sm" label={t('automations.editor.needsAttention')} /> : null}
            </span>
            <span dir="auto" className="block truncate text-xs text-muted">
              {summarizeStep(step, t)}
            </span>
          </span>
          <ChevronDown className={['size-4 shrink-0 text-muted transition-transform duration-200', expanded ? 'rotate-180' : ''].join(' ')} />
        </button>
        <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label={t('automations.editor.stepActions', { index: index + 1 })}>
          <IconButton label={t('automations.editor.moveUp')} icon={<ArrowUp />} isDisabled={isDisabled || index === 0} onPress={() => onMove(-1)} />
          <IconButton label={t('automations.editor.moveDown')} icon={<ArrowDown />} isDisabled={isDisabled || index === total - 1} onPress={() => onMove(1)} />
          <IconButton label={t('automations.editor.duplicate')} icon={<Copy />} isDisabled={isDisabled} onPress={onDuplicate} />
          <IconButton label={t('automations.editor.remove')} icon={<TrashBin />} isDisabled={isDisabled} onPress={onRemove} className="hover:text-danger" />
        </div>
      </div>
      {expanded ? (
        <div id={bodyId} className="flex flex-col gap-3 border-t border-hairline px-4 pt-3 pb-4">
          <StepTypeHint text={t(stepDescriptionKey(step.type))} />
          <StepFields step={step} onChange={onChange} issues={issues} showErrors={showErrors} autoFocus={autoFocus} />
        </div>
      ) : null}
    </li>
  );
}
