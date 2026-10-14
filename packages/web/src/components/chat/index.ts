// Chat building blocks shared by the Live Control assistant panel and the
// AI Assistant page.

import { composerDisabledReason, needsCloudDisclosure, providerReadiness } from '../../lib/device-state';
import { useI18n } from '../../lib/i18n';
import { useActiveTask, useAppStore } from '../../state/store';

export { ApprovalCard, formatCountdown, type ApprovalCardProps } from './ApprovalCard';
export { ChatThread, type ChatThreadProps } from './ChatThread';
export { CloudDisclosureNotice, type CloudDisclosureNoticeProps } from './CloudDisclosureNotice';
export { Composer, type ComposerProps } from './Composer';
export { MessageBubble, type MessageBubbleProps } from './MessageBubble';
export { StepTimeline, type StepTimelineProps } from './StepTimeline';
export { TaskProgress, type TaskProgressProps } from './TaskProgress';
export { formatArgs, formatDuration, RISK_KEY, RISK_TONE, STEP_TYPE_KEY, TASK_STATUS_KEY, TASK_STATUS_TONE } from './task-ui';

/**
 * Translated reason why a new instruction cannot be sent right now (offline,
 * view-only session, stop latched, no usable provider, task already running,
 * cloud privacy notice not accepted yet), or null. Pass it to
 * <Composer disabledReason> and render <CloudDisclosureNotice> above it.
 */
export function useComposerDisabledReason(): string | null {
  const { t } = useI18n();
  const settings = useAppStore((s) => s.settings);
  const session = useAppStore((s) => s.session);
  const stopLatched = useAppStore((s) => s.stop.latched);
  const connected = useAppStore((s) => s.connection.socket === 'open');
  const activeTask = useActiveTask();
  const key =
    composerDisabledReason({ settings, session, stopLatched, activeTask, connected }) ??
    (needsCloudDisclosure(settings, providerReadiness(settings).provider) ? 'composer.reason.disclosure' : null);
  return key ? t(key) : null;
}
