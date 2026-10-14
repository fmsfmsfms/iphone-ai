// "Add step" menu: every workflow step type, grouped, with a friendly name and
// a one-line description.

import { Plus } from '@gravity-ui/icons';
import type { WorkflowStepType } from '@iphone-ai/shared';
import { Button, Description, Dropdown, Header, Label, Separator } from '@heroui/react';
import { Fragment } from 'react';

import { useI18n } from '../../lib/i18n';
import { StepIcon } from './StepIcon';
import { STEP_GROUPS, STEP_TYPES, stepDescriptionKey, stepNameKey } from './step-meta';

export interface AddStepMenuProps {
  onAdd: (type: WorkflowStepType) => void;
  isDisabled?: boolean;
  variant?: 'primary' | 'secondary' | 'tertiary' | 'ghost';
  fullWidth?: boolean;
}

function isStepType(key: unknown): key is WorkflowStepType {
  return typeof key === 'string' && (STEP_TYPES as readonly string[]).includes(key);
}

export function AddStepMenu({ onAdd, isDisabled, variant = 'secondary', fullWidth }: AddStepMenuProps) {
  const { t } = useI18n();
  return (
    <Dropdown>
      <Button size="sm" variant={variant} isDisabled={isDisabled} fullWidth={fullWidth} aria-label={t('automations.editor.addStep')}>
        <Plus className="size-3.5" />
        {t('automations.editor.addStep')}
      </Button>
      <Dropdown.Popover placement="bottom end" className="max-h-[min(70vh,560px)] w-[22rem] max-w-[calc(100vw-2rem)] overflow-auto">
        <Dropdown.Menu aria-label={t('automations.editor.addStep')} onAction={(key) => isStepType(key) && onAdd(key)}>
          {STEP_GROUPS.map(({ group, types }, i) => (
            <Fragment key={group}>
              {i > 0 ? <Separator /> : null}
              <Dropdown.Section>
                <Header className="px-2 pt-1.5 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">
                  {t(`automations.group.${group}`)}
                </Header>
                {types.map((type) => (
                  <Dropdown.Item key={type} id={type} textValue={t(stepNameKey(type))}>
                    <StepIcon type={type} size="sm" />
                    <div className="flex min-w-0 flex-col">
                      <Label className="text-[13px]">{t(stepNameKey(type))}</Label>
                      <Description className="text-[11px] leading-snug whitespace-normal">{t(stepDescriptionKey(type))}</Description>
                    </div>
                  </Dropdown.Item>
                ))}
              </Dropdown.Section>
            </Fragment>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
