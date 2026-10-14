// Where a workflow came from: written by hand, suggested by AI, recorded, imported.

import { CircleFill, FileArrowDown, Pencil, Sparkles } from '@gravity-ui/icons';
import type { Workflow } from '@iphone-ai/shared';
import type { ReactNode } from 'react';

import { StatusChip, type Tone } from '../../components/StatusChip';
import { useI18n } from '../../lib/i18n';

const SOURCE: Record<Workflow['source'], { icon: ReactNode; tone: Tone }> = {
  manual: { icon: <Pencil />, tone: 'default' },
  'ai-suggested': { icon: <Sparkles />, tone: 'ai' },
  recorded: { icon: <CircleFill className="scale-75 text-danger" />, tone: 'default' },
  imported: { icon: <FileArrowDown />, tone: 'default' },
};

export function SourceBadge({ source }: { source: Workflow['source'] }) {
  const { t } = useI18n();
  const meta = SOURCE[source];
  return <StatusChip size="sm" hideDot tone={meta.tone} icon={meta.icon} label={t(`automations.source.${source}`)} />;
}
