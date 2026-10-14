// Full-window states shown before the shell can render: starting up, session
// expired, backend unreachable.

import { ArrowsRotateRight, LockFill, PlugConnection, Smartphone } from '@gravity-ui/icons';
import { Button, Spinner } from '@heroui/react';
import type { ReactNode } from 'react';

import { useNow } from '../components/RelativeTime';
import { useI18n } from '../lib/i18n';
import { realtime } from '../lib/ws';
import { bootstrap, useAppStore } from '../state/store';

function Frame({ icon, tone, title, children, actions }: { icon: ReactNode; tone: 'ai' | 'warning' | 'danger'; title: string; children?: ReactNode; actions?: ReactNode }) {
  const toneClass = tone === 'ai' ? 'ai-gradient-bg text-white' : tone === 'warning' ? 'bg-warning/15 text-warning' : 'bg-danger/15 text-danger';
  return (
    <div className="flex h-full items-center justify-center bg-background p-6">
      <div className="app-panel w-full max-w-md p-8 text-center shadow-[0_30px_80px_rgb(0_0_0/0.45)]">
        <span aria-hidden className={['mx-auto flex size-14 items-center justify-center rounded-2xl [&>svg]:size-6', toneClass].join(' ')}>
          {icon}
        </span>
        <h1 className="mt-5 text-xl font-semibold tracking-tight text-foreground">{title}</h1>
        <div className="mt-2 space-y-2 text-[13px] leading-relaxed text-muted">{children}</div>
        {actions ? <div className="mt-6 flex flex-wrap justify-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

export function Splash() {
  const { t } = useI18n();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 bg-background" role="status" aria-live="polite">
      <span aria-hidden className="ai-gradient-bg flex size-14 items-center justify-center rounded-2xl text-white shadow-[0_10px_40px_rgb(94_92_230/0.35)] [&>svg]:size-6">
        <Smartphone />
      </span>
      <div className="flex items-center gap-2.5 text-[13px] text-muted">
        <Spinner size="sm" />
        {t('boot.connecting')}
      </div>
    </div>
  );
}

export function SessionExpired() {
  const { t } = useI18n();
  return (
    <Frame
      icon={<LockFill />}
      tone="warning"
      title={t('boot.expired.title')}
      actions={
        <Button variant="secondary" onPress={() => window.location.reload()}>
          <ArrowsRotateRight className="size-4" />
          {t('boot.expired.retry')}
        </Button>
      }
    >
      <p>{t('boot.expired.body')}</p>
      <p>{t('boot.expired.body2')}</p>
    </Frame>
  );
}

export function BackendUnreachable() {
  const { t } = useI18n();
  const connection = useAppStore((s) => s.connection);
  const bootError = useAppStore((s) => s.bootError);
  const now = useNow(1000);
  const seconds = connection.nextRetryAt ? Math.max(0, Math.ceil((connection.nextRetryAt - now) / 1000)) : null;
  return (
    <Frame
      icon={<PlugConnection />}
      tone="danger"
      title={t('boot.unreachable.title')}
      actions={
        <Button
          variant="primary"
          onPress={() => {
            realtime.reconnectNow();
            void bootstrap();
          }}
        >
          <ArrowsRotateRight className="size-4" />
          {t('common.tryAgain')}
        </Button>
      }
    >
      <p>{t('boot.unreachable.body')}</p>
      <p>{t('boot.unreachable.body2')}</p>
      <p className="text-xs text-muted/80">
        {seconds !== null && seconds > 0 ? t('boot.unreachable.retrying', { seconds }) : t('boot.unreachable.retryingNow')}
      </p>
      {bootError ? <p className="font-mono text-[11px] text-muted/70">{bootError}</p> : null}
    </Frame>
  );
}
