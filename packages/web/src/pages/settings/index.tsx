// Settings: section navigation (General, iPhone Connection, AI Providers,
// Permissions, Automation, Privacy, Remote Access, Advanced) and content.
// Route: #/settings[/<section>] — "ai" is an alias for AI Providers.

import { BroadcastSignal, EyeSlash, Gear, PlugConnection, Shield, Sliders, Sparkles, Thunderbolt, Wrench } from '@gravity-ui/icons';
import { Skeleton } from '@heroui/react';
import { useEffect, useRef, type ReactNode } from 'react';

import { ErrorBoundary } from '../../components/ErrorBoundary';
import { Page } from '../../components/Page';
import { useI18n } from '../../lib/i18n';
import { href } from '../../lib/router';
import { useSettings } from '../../state/store';
import { AdvancedSection } from './AdvancedSection';
import { AutomationSection } from './AutomationSection';
import { ConnectionSection } from './ConnectionSection';
import { GeneralSection } from './GeneralSection';
import { resolveSection, SECTION_IDS, type SectionId } from './helpers';
import './messages';
import { PermissionsSection } from './PermissionsSection';
import { PrivacySection } from './PrivacySection';
import { ProvidersSection } from './ProvidersSection';
import { RemoteSection } from './RemoteSection';

const SECTION_ICON: Record<SectionId, ReactNode> = {
  general: <Sliders />,
  connection: <PlugConnection />,
  providers: <Sparkles />,
  permissions: <Shield />,
  automation: <Thunderbolt />,
  privacy: <EyeSlash />,
  remote: <BroadcastSignal />,
  advanced: <Wrench />,
};

function SectionContent({ id }: { id: SectionId }) {
  switch (id) {
    case 'general':
      return <GeneralSection />;
    case 'connection':
      return <ConnectionSection />;
    case 'providers':
      return <ProvidersSection />;
    case 'permissions':
      return <PermissionsSection />;
    case 'automation':
      return <AutomationSection />;
    case 'privacy':
      return <PrivacySection />;
    case 'remote':
      return <RemoteSection />;
    case 'advanced':
      return <AdvancedSection />;
  }
}

function SettingsNav({ current }: { current: SectionId }) {
  const { t } = useI18n();
  return (
    <nav aria-label={t('settings.nav.label')} className="lg:sticky lg:top-0 lg:self-start">
      <ul className="app-scroll -mx-1 flex gap-1 overflow-x-auto px-1 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0 lg:pb-0">
        {SECTION_IDS.map((id) => {
          const active = id === current;
          return (
            <li key={id} className="shrink-0">
              <a
                href={href({ name: 'settings', section: id })}
                aria-current={active ? 'page' : undefined}
                className={[
                  'app-transition relative flex h-9 items-center gap-2.5 rounded-xl px-3 text-[13px] font-medium whitespace-nowrap outline-none',
                  'focus-visible:ring-2 focus-visible:ring-focus',
                  active ? 'bg-active text-foreground' : 'text-muted hover:bg-hover hover:text-foreground',
                ].join(' ')}
              >
                <span aria-hidden className={['flex size-4 shrink-0 items-center justify-center [&>svg]:size-4', active ? 'text-accent' : ''].join(' ')}>
                  {SECTION_ICON[id]}
                </span>
                {t(`settings.nav.${id}`)}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export default function SettingsPage(props: { section?: string }) {
  const { t } = useI18n();
  const settings = useSettings();
  const id = resolveSection(props.section);

  // Each section starts at the top of the page's scroll area.
  const contentRef = useRef<HTMLDivElement>(null);
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    contentRef.current?.closest('.app-scroll')?.scrollTo({ top: 0 });
  }, [id]);

  return (
    <Page title={t('nav.settings')} description={t('settings.description')} icon={<Gear />} width="wide">
      <div className="grid gap-6 lg:grid-cols-[13.5rem_minmax(0,1fr)]">
        <SettingsNav current={id} />
        <div ref={contentRef} className="min-w-0">
          {settings ? (
            <ErrorBoundary area={t(`settings.nav.${id}`)} key={id}>
              <SectionContent id={id} />
            </ErrorBoundary>
          ) : (
            <div className="flex flex-col gap-4" aria-busy>
              <Skeleton className="h-10 w-64 rounded-xl" />
              <Skeleton className="h-48 rounded-2xl" />
              <Skeleton className="h-32 rounded-2xl" />
            </div>
          )}
        </div>
      </div>
    </Page>
  );
}
