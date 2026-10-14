// Dashboard: setup checklist, live preview, connection health, active work,
// recent activity and stream statistics.

import './messages';

import { ArrowUpRightFromSquare, ArrowsRotateRight, LayoutHeaderCellsLarge, Smartphone } from '@gravity-ui/icons';
import { Button } from '@heroui/react';
import { useState } from 'react';

import { IconButton } from '../../components/IconButton';
import { Page } from '../../components/Page';
import { Panel } from '../../components/Panel';
import { PhoneViewer } from '../../components/phone/PhoneViewer';
import { checkConnection } from '../../components/phone/phone-actions';
import { useI18n } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { useStatus } from '../../state/store';
import { ActivityCard } from './ActivityCard';
import { HealthCard } from './HealthCard';
import { OnboardingChecklist, useOnboardingItems } from './Onboarding';
import { StreamCard } from './StreamCard';
import { WorkCard } from './WorkCard';

export default function DashboardPage() {
  const { t } = useI18n();
  const status = useStatus();
  const { items, loading } = useOnboardingItems();
  const [refreshing, setRefreshing] = useState(false);
  const ready = !loading && items.slice(0, 4).every((i) => i.done);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await checkConnection();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Page
      title={t('dashboard.title')}
      icon={<LayoutHeaderCellsLarge />}
      description={!status ? t('dashboard.summary.loading') : ready ? t('dashboard.summary.ready') : t('dashboard.summary.attention')}
      actions={
        <>
          <Button size="sm" variant="secondary" isPending={refreshing} onPress={() => void refresh()}>
            <ArrowsRotateRight className="size-3.5" />
            {t('dashboard.refreshStatus')}
          </Button>
          <Button size="sm" variant="primary" onPress={() => navigate({ name: 'live' })}>
            <Smartphone className="size-3.5" />
            {t('dashboard.openLive')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <OnboardingChecklist items={items} />
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="flex min-w-0 flex-col gap-5">
            <WorkCard />
            <HealthCard />
            <ActivityCard />
          </div>
          <div className="flex min-w-0 flex-col gap-5 xl:sticky xl:top-0">
            <Panel
              icon={<Smartphone />}
              title={t('dashboard.preview.title')}
              description={t('dashboard.preview.description')}
              actions={<IconButton label={t('dashboard.openLive')} icon={<ArrowUpRightFromSquare />} onPress={() => navigate({ name: 'live' })} />}
            >
              <div className="h-[460px]">
                <PhoneViewer variant="compact" toolbar={false} interactive={false} />
              </div>
            </Panel>
            <StreamCard />
          </div>
        </div>
      </div>
    </Page>
  );
}
