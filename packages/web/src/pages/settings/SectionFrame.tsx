// Section heading + read-only scope shared by every settings section, and
// the hook that decides whether this session may change a section.

import type { ReactNode } from 'react';

import { useI18n } from '../../lib/i18n';
import { useAppStore } from '../../state/store';
import { EditableScope, ReadOnlyNotice } from './fields';

export interface SectionAccess {
  editable: boolean;
  reason: string | null;
  /** True for the desktop app and local browsers (never remote devices). */
  isLocal: boolean;
  canControl: boolean;
}

/**
 * Remote sessions may change only General settings (the backend enforces
 * this); view-only sessions can't change anything.
 */
export function useSectionAccess(scope: 'general' | 'local'): SectionAccess {
  const { t } = useI18n();
  const canControl = useAppStore((s) => s.session?.canControl ?? s.hello?.canControl ?? false);
  const remote = useAppStore((s) => s.session?.remote ?? s.hello?.remote ?? false);
  if (!canControl) return { editable: false, reason: t('settings.readOnly.viewOnly'), isLocal: !remote, canControl };
  if (remote && scope === 'local') return { editable: false, reason: t('settings.readOnly.remote'), isLocal: false, canControl };
  return { editable: true, reason: null, isLocal: !remote, canControl };
}

export interface SectionFrameProps {
  title: string;
  description?: ReactNode;
  icon: ReactNode;
  access: SectionAccess;
  children: ReactNode;
  actions?: ReactNode;
}

export function SectionFrame({ title, description, icon, access, children, actions }: SectionFrameProps) {
  return (
    <EditableScope editable={access.editable}>
      <section aria-labelledby="settings-section-title" className="flex flex-col gap-4">
        <header className="flex flex-wrap items-start gap-3">
          <span aria-hidden className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-default text-foreground [&>svg]:size-[18px]">
            {icon}
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="settings-section-title" className="text-[17px] leading-7 font-semibold tracking-tight text-foreground">
              {title}
            </h2>
            {description ? <p className="text-[13px] leading-5 text-muted">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
        <ReadOnlyNotice reason={access.reason} />
        {children}
      </section>
    </EditableScope>
  );
}
