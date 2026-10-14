// Route → page component. Every page is lazy-loaded.

import { Spinner } from '@heroui/react';
import { lazy, Suspense } from 'react';

import { useI18n } from '../lib/i18n';
import type { Route } from '../lib/router';

const DashboardPage = lazy(() => import('../pages/dashboard/index'));
const LivePage = lazy(() => import('../pages/live/index'));
const AssistantPage = lazy(() => import('../pages/assistant/index'));
const AutomationsPage = lazy(() => import('../pages/automations/index'));
const ActivityPage = lazy(() => import('../pages/activity/index'));
const SettingsPage = lazy(() => import('../pages/settings/index'));

function PageFallback() {
  const { t } = useI18n();
  return (
    <div className="flex h-full items-center justify-center gap-2 text-[13px] text-muted" role="status">
      <Spinner size="sm" />
      {t('common.loading')}
    </div>
  );
}

export function RouteView({ route }: { route: Route }) {
  let page;
  switch (route.name) {
    case 'dashboard':
      page = <DashboardPage />;
      break;
    case 'live':
      page = <LivePage />;
      break;
    case 'assistant':
      page = <AssistantPage conversationId={route.conversationId} />;
      break;
    case 'automations':
      page = <AutomationsPage workflowId={route.workflowId} />;
      break;
    case 'activity':
      page = <ActivityPage />;
      break;
    case 'settings':
      page = <SettingsPage section={route.section} />;
      break;
  }
  return <Suspense fallback={<PageFallback />}>{page}</Suspense>;
}
