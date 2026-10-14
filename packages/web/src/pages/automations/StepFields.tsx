// Per-type form for one workflow step. Field errors come from the shared
// workflowStepSchema (see validateStep); they are shown once the step has
// been edited or the user tried to save.

import { CircleInfo, Flag, Shield, Sparkles, TriangleExclamation } from '@gravity-ui/icons';
import type { SwipeDirection, WorkflowStep } from '@iphone-ai/shared';
import { Button } from '@heroui/react';

import { useI18n } from '../../lib/i18n';
import { useAppStore } from '../../state/store';
import { Notice, NumberInput, SelectInput, TextInput, ToggleRow } from './fields';
import { COMMON_KEYS, parseGeometryId, type StepIssue } from './step-meta';

export interface StepFieldsProps {
  step: WorkflowStep;
  onChange: (step: WorkflowStep) => void;
  issues: StepIssue[];
  showErrors: boolean;
  autoFocus?: boolean;
}

const DIRECTIONS: readonly SwipeDirection[] = ['up', 'down', 'left', 'right'];

export function StepFields({ step, onChange, issues, showErrors, autoFocus }: StepFieldsProps) {
  const { t } = useI18n();
  const liveGeometry = useAppStore((s) => s.status?.mirroring.geometry ?? null);

  const update = (patch: Record<string, unknown>) => onChange({ ...step, ...patch } as WorkflowStep);
  const errorFor = (field: string): string | null => {
    if (!showErrors) return null;
    const issue = issues.find((i) => i.field === field);
    return issue ? t(issue.key, issue.vars) : null;
  };
  const directionOptions = DIRECTIONS.map((d) => ({ id: d, label: t(`automations.direction.${d}`) }));
  const labelField = (description: string, placeholder: string) =>
    'label' in step ? (
      <TextInput
        label={t('automations.field.label')}
        value={step.label}
        onChange={(label) => update({ label })}
        error={errorFor('label')}
        description={description}
        placeholder={placeholder}
        maxLength={200}
        autoFocus={autoFocus}
      />
    ) : null;

  switch (step.type) {
    case 'launch_app':
      return (
        <TextInput
          label={t('automations.field.app')}
          value={step.app}
          onChange={(app) => update({ app })}
          error={errorFor('app')}
          description={t('automations.field.appHint')}
          placeholder={t('automations.field.appPlaceholder')}
          maxLength={120}
          autoFocus={autoFocus}
        />
      );

    case 'tap_text':
      return (
        <div className="flex flex-col gap-3">
          {labelField(t('automations.field.labelHint'), t('automations.field.labelPlaceholder'))}
          <ToggleRow
            label={t('automations.field.exact')}
            description={t('automations.field.exactHint')}
            isSelected={step.exact === true}
            onChange={(exact) => update({ exact: exact ? true : undefined })}
          />
        </div>
      );

    case 'long_press_text':
      return labelField(t('automations.field.labelHint'), t('automations.field.labelPlaceholder'));

    case 'tap_point': {
      const recorded = parseGeometryId(step.geometryId);
      const mismatch = Boolean(liveGeometry && step.geometryId && liveGeometry.geometryId !== step.geometryId);
      return (
        <div className="flex flex-col gap-3">
          <Notice tone={mismatch || !recorded ? 'danger' : 'warning'} icon={<TriangleExclamation />} title={t('automations.tapPoint.title')}>
            <p>
              {recorded
                ? t('automations.tapPoint.validFor', { width: recorded.width, height: recorded.height })
                : t('automations.tapPoint.unknownSize')}
            </p>
            {mismatch && liveGeometry ? (
              <p className="mt-1 text-danger">
                {t('automations.tapPoint.mismatch', { width: Math.round(liveGeometry.widthPt), height: Math.round(liveGeometry.heightPt) })}
              </p>
            ) : null}
            <p className="mt-1">{t('automations.tapPoint.advice')}</p>
          </Notice>
          <div className="grid grid-cols-2 gap-3">
            <NumberInput label={t('automations.field.x')} value={step.x} onChange={(x) => update({ x: x ?? 0 })} min={0} max={4000} maximumFractionDigits={1} error={errorFor('x')} />
            <NumberInput label={t('automations.field.y')} value={step.y} onChange={(y) => update({ y: y ?? 0 })} min={0} max={4000} maximumFractionDigits={1} error={errorFor('y')} />
          </div>
          <TextInput
            label={t('automations.field.note')}
            value={step.note ?? ''}
            onChange={(note) => update({ note: note || undefined })}
            error={errorFor('note')}
            description={t('automations.field.noteHint')}
            maxLength={200}
          />
          {!step.geometryId && liveGeometry ? (
            <div>
              <Button size="sm" variant="secondary" onPress={() => update({ geometryId: liveGeometry.geometryId })}>
                {t('automations.tapPoint.useCurrent', { width: Math.round(liveGeometry.widthPt), height: Math.round(liveGeometry.heightPt) })}
              </Button>
            </div>
          ) : null}
        </div>
      );
    }

    case 'swipe':
      return (
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectInput
              label={t('automations.field.direction')}
              value={step.direction}
              onChange={(direction) => update({ direction })}
              options={directionOptions}
            />
            <SelectInput
              label={t('automations.field.distance')}
              value={step.distance ?? 'medium'}
              onChange={(distance) => update({ distance })}
              options={(['short', 'medium', 'long'] as const).map((d) => ({ id: d, label: t(`automations.distance.${d}`) }))}
            />
          </div>
          <p className="text-[11px] leading-relaxed text-muted">{t('automations.field.swipeHint')}</p>
        </div>
      );

    case 'type_text':
      return (
        <div className="flex flex-col gap-3">
          <TextInput
            label={t('automations.field.text')}
            value={step.text}
            onChange={(text) => update({ text })}
            error={errorFor('text')}
            description={t('automations.field.textHint')}
            placeholder={t('automations.field.textPlaceholder')}
            maxLength={2000}
            multiline={!step.sensitive}
            rows={2}
            type={step.sensitive ? 'password' : 'text'}
            autoFocus={autoFocus}
          />
          <ToggleRow
            label={t('automations.field.sensitive')}
            description={t('automations.field.sensitiveHint')}
            isSelected={step.sensitive === true}
            onChange={(sensitive) => update({ sensitive: sensitive ? true : undefined })}
          />
          <Notice icon={<Shield />}>{t('automations.field.typingPolicy')}</Notice>
        </div>
      );

    case 'press_key':
      return (
        <div className="flex flex-col gap-2">
          <TextInput
            label={t('automations.field.key')}
            value={step.key}
            onChange={(key) => update({ key })}
            error={errorFor('key')}
            description={t('automations.field.keyHint')}
            maxLength={32}
            mono
            dirAuto={false}
            autoFocus={autoFocus}
          />
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('automations.field.keyQuick')}>
            {COMMON_KEYS.map((key) => (
              <Button
                key={key}
                size="sm"
                variant={step.key === key ? 'primary' : 'tertiary'}
                className="h-7 rounded-lg px-2 font-mono text-[11px]"
                onPress={() => update({ key })}
              >
                {key}
              </Button>
            ))}
          </div>
        </div>
      );

    case 'press_home':
      return <p className="text-xs leading-relaxed text-muted">{t('automations.field.homeHint')}</p>;

    case 'press_back':
      return <p className="text-xs leading-relaxed text-muted">{t('automations.field.backHint')}</p>;

    case 'open_url':
      return (
        <div className="flex flex-col gap-3">
          <Notice tone="warning" icon={<TriangleExclamation />} title={t('automations.openUrl.title')}>
            {t('automations.openUrl.body')}
          </Notice>
          <TextInput
            label={t('automations.field.url')}
            value={step.url}
            onChange={(url) => update({ url })}
            error={errorFor('url')}
            maxLength={2048}
            type="url"
            mono
            dirAuto={false}
          />
        </div>
      );

    case 'scroll_to':
      return (
        <div className="flex flex-col gap-3">
          {labelField(t('automations.field.scrollHint'), t('automations.field.labelPlaceholder'))}
          <SelectInput
            label={t('automations.field.direction')}
            value={step.direction ?? 'auto'}
            onChange={(value) => update({ direction: value === 'auto' ? undefined : value })}
            options={[{ id: 'auto', label: t('automations.direction.auto') }, ...directionOptions]}
          />
        </div>
      );

    case 'wait_for_text':
      return (
        <div className="flex flex-col gap-3">
          {labelField(t('automations.field.waitHint'), t('automations.field.labelPlaceholder'))}
          <NumberInput
            label={t('automations.field.timeout')}
            value={step.timeoutMs === undefined ? undefined : step.timeoutMs / 1000}
            onChange={(sec) => update({ timeoutMs: sec === undefined ? undefined : Math.round(sec * 1000) })}
            min={0.5}
            max={120}
            step={0.5}
            maximumFractionDigits={1}
            error={errorFor('timeoutMs')}
            description={t('automations.field.timeoutHint')}
          />
        </div>
      );

    case 'assert_text':
      return (
        <div className="flex flex-col gap-3">
          {labelField(t('automations.field.assertHint'), t('automations.field.labelPlaceholder'))}
          <SelectInput
            label={t('automations.field.expect')}
            value={step.present ? 'present' : 'absent'}
            onChange={(value) => update({ present: value === 'present' })}
            options={[
              { id: 'present', label: t('automations.field.expectPresent') },
              { id: 'absent', label: t('automations.field.expectAbsent') },
            ]}
          />
        </div>
      );

    case 'screenshot':
      return (
        <TextInput
          label={t('automations.field.screenshotName')}
          value={step.label}
          onChange={(label) => update({ label })}
          error={errorFor('label')}
          description={t('automations.field.screenshotHint')}
          placeholder={t('automations.field.screenshotPlaceholder')}
          maxLength={120}
          autoFocus={autoFocus}
        />
      );

    case 'read_screen':
      return (
        <div className="flex flex-col gap-3">
          <TextInput
            label={t('automations.field.saveAs')}
            value={step.saveAs}
            onChange={(saveAs) => update({ saveAs })}
            error={errorFor('saveAs')}
            description={t('automations.field.saveAsHint', { name: `{${step.saveAs.trim() || 'value'}}` })}
            maxLength={60}
            mono
            dirAuto={false}
            autoFocus={autoFocus}
          />
          <TextInput
            label={t('automations.field.readInstruction')}
            value={step.instruction ?? ''}
            onChange={(instruction) => update({ instruction: instruction || undefined })}
            error={errorFor('instruction')}
            description={t('automations.field.readInstructionHint')}
            placeholder={t('automations.field.readInstructionPlaceholder')}
            maxLength={500}
            multiline
            rows={2}
          />
        </div>
      );

    case 'ai_task':
      return (
        <div className="flex flex-col gap-3">
          <TextInput
            label={t('automations.field.instruction')}
            value={step.instruction}
            onChange={(instruction) => update({ instruction })}
            error={errorFor('instruction')}
            placeholder={t('automations.field.instructionPlaceholder')}
            maxLength={2000}
            multiline
            rows={3}
            autoFocus={autoFocus}
          />
          <NumberInput
            label={t('automations.field.maxActions')}
            value={step.maxActions}
            onChange={(maxActions) => update({ maxActions })}
            min={1}
            max={100}
            error={errorFor('maxActions')}
            description={t('automations.field.maxActionsHint')}
          />
          <Notice tone="ai" icon={<Sparkles />}>{t('automations.field.aiTaskHint')}</Notice>
        </div>
      );

    case 'checkpoint':
      return (
        <div className="flex flex-col gap-3">
          <Notice tone="warning" icon={<Flag />} title={t('automations.checkpoint.title')}>
            {t('automations.checkpoint.body')}
          </Notice>
          <TextInput
            label={t('automations.field.message')}
            value={step.message}
            onChange={(message) => update({ message })}
            error={errorFor('message')}
            description={t('automations.field.messageHint')}
            placeholder={t('automations.field.messagePlaceholder')}
            maxLength={500}
            multiline
            rows={2}
            autoFocus={autoFocus}
          />
        </div>
      );

    case 'wait':
      return (
        <NumberInput
          label={t('automations.field.seconds')}
          value={step.ms / 1000}
          onChange={(sec) => update({ ms: sec === undefined ? Number.NaN : Math.round(sec * 1000) })}
          min={0.1}
          max={60}
          step={0.5}
          maximumFractionDigits={1}
          error={errorFor('ms')}
          description={t('automations.field.waitSecondsHint')}
        />
      );
  }
}

/** Short explanation shown at the top of an expanded step. */
export function StepTypeHint({ text }: { text: string }) {
  return (
    <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted">
      <CircleInfo className="mt-0.5 size-3.5 shrink-0" />
      {text}
    </p>
  );
}
