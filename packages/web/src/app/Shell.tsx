// Main window layout: sidebar | (status bar / page).

import { useMediaQuery } from '@heroui/react';
import { useState } from 'react';

import { ErrorBoundary } from '../components/ErrorBoundary';
import { useI18n } from '../lib/i18n';
import { useRoute } from '../lib/router';
import { readJson, STORAGE_KEYS, writeJson } from '../lib/storage';
import { GlobalShortcuts } from './GlobalShortcuts';
import { RouteView } from './routes';
import { ShortcutsDialog } from './ShortcutsDialog';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { ApprovalWatcher, FocusStealWatcher } from './Watchers';

export function Shell() {
  const { t } = useI18n();
  const route = useRoute();
  const [collapsedPref, setCollapsed] = useState(() => readJson<boolean>(STORAGE_KEYS.sidebarCollapsed, false));
  // Narrow windows (or remote browsers) always get the icon-only sidebar.
  const narrow = useMediaQuery('(max-width: 960px)', { initializeWithValue: true });
  const collapsed = collapsedPref || narrow;
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const toggle = () => {
    setCollapsed((c) => {
      writeJson(STORAGE_KEYS.sidebarCollapsed, !c);
      return !c;
    });
  };

  return (
    <div className="flex h-full bg-background text-foreground">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:start-2 focus:z-50 focus:rounded-lg focus:bg-accent focus:px-3 focus:py-2 focus:text-white"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main')?.focus();
        }}
      >
        {t('nav.skipToContent')}
      </a>
      <Sidebar route={route} collapsed={collapsed} onToggleCollapsed={toggle} onShowShortcuts={() => setShortcutsOpen(true)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main id="main" tabIndex={-1} className="relative min-h-0 flex-1 overflow-hidden outline-none">
          <ErrorBoundary resetKey={route.name} area={t(`nav.${route.name}`)}>
            <RouteView route={route} />
          </ErrorBoundary>
        </main>
      </div>
      <ShortcutsDialog isOpen={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <GlobalShortcuts onShowShortcuts={() => setShortcutsOpen(true)} />
      <FocusStealWatcher />
      <ApprovalWatcher />
    </div>
  );
}
