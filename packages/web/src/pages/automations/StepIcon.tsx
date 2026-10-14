// Icon and tint for each workflow step type.

import {
  ArrowRotateLeft,
  ArrowsExpandVertical,
  Camera,
  CircleCheck,
  Eye,
  Flag,
  Globe,
  Hand,
  HandPointUp,
  Hourglass,
  House,
  Keyboard,
  Magnifier,
  Rocket,
  Sparkles,
  Stopwatch,
  Target,
  Text,
} from '@gravity-ui/icons';
import type { WorkflowStepType } from '@iphone-ai/shared';
import type { ReactNode } from 'react';

const ICONS: Record<WorkflowStepType, ReactNode> = {
  launch_app: <Rocket />,
  tap_text: <HandPointUp />,
  long_press_text: <Hand />,
  tap_point: <Target />,
  swipe: <ArrowsExpandVertical />,
  type_text: <Text />,
  press_key: <Keyboard />,
  press_home: <House />,
  press_back: <ArrowRotateLeft />,
  open_url: <Globe />,
  scroll_to: <Magnifier />,
  wait_for_text: <Hourglass />,
  assert_text: <CircleCheck />,
  screenshot: <Camera />,
  read_screen: <Eye />,
  ai_task: <Sparkles />,
  checkpoint: <Flag />,
  wait: <Stopwatch />,
};

function tint(type: WorkflowStepType): string {
  if (type === 'ai_task') return 'ai-gradient-bg text-white';
  if (type === 'checkpoint') return 'bg-warning/15 text-warning';
  if (type === 'tap_point' || type === 'open_url') return 'bg-warning/12 text-warning';
  if (type === 'wait_for_text' || type === 'assert_text' || type === 'read_screen' || type === 'screenshot') return 'bg-success/12 text-success';
  return 'bg-accent/12 text-accent';
}

export function StepIcon({ type, size = 'md' }: { type: WorkflowStepType; size?: 'sm' | 'md' }) {
  return (
    <span
      aria-hidden
      className={[
        'flex shrink-0 items-center justify-center',
        size === 'sm' ? 'size-6 rounded-md [&>svg]:size-3.5' : 'size-8 rounded-lg [&>svg]:size-4',
        tint(type),
      ].join(' ')}
    >
      {ICONS[type]}
    </span>
  );
}
