// Full-window states shown before the shell can render: starting up, session
// expired (local listener), passcode sign-in (remote listener), backend
// unreachable.

import { ArrowsRotateRight, LockFill, PlugConnection, Smartphone, TriangleExclamationFill } from '@gravity-ui/icons';
import { Button, Description, Input, Label, Spinner, TextField } from '@heroui/react';
import { useRef, useState, type FormEvent, type ReactNode } from 'react';

import { useNow } from '../components/RelativeTime';
import { api, ApiError } from '../lib/api';
import { useI18n, type MessageVars } from '../lib/i18n';
import { readJson, STORAGE_KEYS, writeJson } from '../lib/storage';
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

/** Maximum lengths accepted by POST /api/auth/remote-login. */
const PASSCODE_MAX = 128;
const DEVICE_NAME_MAX = 80;

/** A short default name for this browser, e.g. "Safari on iPhone" (the user can change it). */
export function guessDeviceName(userAgent: string, t: (key: string, vars?: MessageVars) => string): string {
  const ua = userAgent;
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /CrOS/.test(ua)
          ? 'Chromebook'
          : /Macintosh|Mac OS X/.test(ua)
            ? 'Mac'
            : /Windows/.test(ua)
              ? 'Windows'
              : /Linux/.test(ua)
                ? 'Linux'
                : '';
  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? 'Edge'
    : /Firefox\/|FxiOS/.test(ua)
      ? 'Firefox'
      : /Chrome\/|CriOS/.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : '';
  const name = os && browser ? t('boot.remote.deviceGuess', { browser, os }) : os || browser;
  return name.slice(0, DEVICE_NAME_MAX);
}

function formatWait(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

type SignInError =
  | { kind: 'invalid' | 'notConfigured' | 'disabled' | 'unreachable' | 'noSession' }
  | { kind: 'rateLimited'; until: number | null }
  | { kind: 'generic'; detail: string };

function toSignInError(err: unknown): SignInError {
  if (err instanceof ApiError) {
    if (err.code === 'invalid_passcode') return { kind: 'invalid' };
    if (err.code === 'rate_limited' || err.status === 429) {
      return { kind: 'rateLimited', until: err.retryAfterSec !== null ? Date.now() + err.retryAfterSec * 1000 : null };
    }
    if (err.code === 'remote_not_configured') return { kind: 'notConfigured' };
    if (err.code === 'remote_disabled') return { kind: 'disabled' };
    if (err.isUnreachable) return { kind: 'unreachable' };
    return { kind: 'generic', detail: err.message };
  }
  return { kind: 'generic', detail: err instanceof Error ? err.message : '' };
}

/**
 * Shown on the remote listener when there is no valid session: the passcode
 * set on the Mac signs this browser in (POST /api/auth/remote-login), then the
 * app loads as usual.
 */
export function RemoteSignIn() {
  const { t } = useI18n();
  // A session existed in this page before: it expired or was revoked.
  const ended = useAppStore((s) => s.session !== null);
  const [passcode, setPasscode] = useState('');
  const [deviceName, setDeviceName] = useState(() => {
    const saved = readJson<unknown>(STORAGE_KEYS.remoteDeviceName, null);
    return typeof saved === 'string' ? saved.slice(0, DEVICE_NAME_MAX) : guessDeviceName(navigator.userAgent, t);
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<SignInError | null>(null);
  const passcodeRef = useRef<HTMLInputElement>(null);
  const until = error?.kind === 'rateLimited' ? error.until : null;
  useNow(until ? 1000 : 60_000); // re-render every second while counting down
  const waitSec = until ? Math.max(0, Math.ceil((until - Date.now()) / 1000)) : 0;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!passcode || pending || waitSec > 0) return;
    setPending(true);
    setError(null);
    const name = deviceName.trim().slice(0, DEVICE_NAME_MAX);
    writeJson(STORAGE_KEYS.remoteDeviceName, name);
    try {
      await api.auth.remoteLogin(passcode, name || undefined);
    } catch (err) {
      const next = toSignInError(err);
      setError(next);
      if (next.kind === 'invalid') {
        setPasscode('');
        passcodeRef.current?.focus();
      }
      setPending(false);
      return;
    }
    // Signed in: forget the passcode, load the app (boot must leave
    // 'unauthorized' before the socket may connect), then reconnect.
    setPasscode('');
    const ok = await bootstrap();
    if (ok) {
      realtime.reconnectNow();
      return; // the shell replaces this screen
    }
    setError({ kind: 'noSession' });
    setPending(false);
  };

  let message: string | null = null;
  if (error) {
    switch (error.kind) {
      case 'invalid':
        message = t('boot.remote.error.invalid');
        break;
      case 'rateLimited':
        message = error.until === null ? t('boot.remote.error.rateLimitedNow') : waitSec > 0 ? t('boot.remote.error.rateLimited', { time: formatWait(waitSec) }) : null;
        break;
      case 'notConfigured':
        message = t('boot.remote.error.notConfigured');
        break;
      case 'disabled':
        message = t('boot.remote.error.disabled');
        break;
      case 'unreachable':
        message = t('boot.remote.error.unreachable');
        break;
      case 'noSession':
        message = t('boot.remote.error.noSession');
        break;
      case 'generic':
        message = error.detail ? `${t('boot.remote.error.generic')} ${error.detail}` : t('boot.remote.error.generic');
        break;
    }
  }

  return (
    <Frame icon={<LockFill />} tone="ai" title={t('boot.remote.title')}>
      {ended ? <p className="font-medium text-warning">{t('boot.remote.ended')}</p> : null}
      <p>{t('boot.remote.body')}</p>
      <form className="mt-5 flex flex-col gap-4 text-start" onSubmit={(e) => void submit(e)} noValidate>
        <TextField value={passcode} onChange={setPasscode} type="password" variant="secondary" className="flex flex-col gap-1.5">
          <Label className="text-xs font-medium text-muted">{t('boot.remote.passcode')}</Label>
          <Input ref={passcodeRef} maxLength={PASSCODE_MAX} autoComplete="off" autoCapitalize="off" spellCheck={false} autoFocus dir="ltr" className="h-10" />
        </TextField>
        <TextField value={deviceName} onChange={setDeviceName} variant="secondary" className="flex flex-col gap-1.5">
          <Label className="text-xs font-medium text-muted">{t('boot.remote.deviceName')}</Label>
          <Input maxLength={DEVICE_NAME_MAX} autoComplete="off" dir="auto" className="h-10" />
          <Description className="text-[11px] leading-relaxed text-muted">{t('boot.remote.deviceNameHint')}</Description>
        </TextField>
        {message ? (
          <p role="alert" className="flex items-start gap-1.5 text-xs leading-relaxed text-danger">
            <TriangleExclamationFill aria-hidden className="mt-0.5 size-3 shrink-0" />
            <span>{message}</span>
          </p>
        ) : null}
        <Button type="submit" variant="primary" fullWidth isPending={pending} isDisabled={!passcode || waitSec > 0}>
          {t('boot.remote.submit')}
        </Button>
      </form>
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
