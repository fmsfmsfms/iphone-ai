// Active AI provider + model, with a popover to switch between the enabled ones.

import { Check, ChevronDown, Cloud, Cpu, Gear, Sparkles } from '@gravity-ui/icons';
import { Button, Popover } from '@heroui/react';
import { useState } from 'react';

import { providerReadiness } from '../lib/device-state';
import { useI18n } from '../lib/i18n';
import { navigate } from '../lib/router';
import { notifyError, setActiveProvider, useAppStore, useCanControl } from '../state/store';

export function ProviderSwitcher() {
  const { t } = useI18n();
  const settings = useAppStore((s) => s.settings);
  const canControl = useCanControl();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  if (!settings) return null;

  const active = providerReadiness(settings);
  const providers = settings.ai.providers.filter((p) => p.enabled);

  const choose = async (id: string) => {
    if (id === settings.ai.activeProviderId) {
      setOpen(false);
      return;
    }
    setSwitching(id);
    try {
      await setActiveProvider(id);
      setOpen(false);
    } catch (err) {
      notifyError(t('provider.switchFailed'), err);
    } finally {
      setSwitching(null);
    }
  };

  return (
    <Popover isOpen={open} onOpenChange={setOpen}>
      <Button
        variant="tertiary"
        size="sm"
        className="h-9 max-w-64 min-w-0 shrink gap-2 rounded-full border border-hairline bg-surface ps-1.5 pe-3"
        aria-label={t('provider.triggerLabel', { provider: active.provider?.label ?? t('provider.none') })}
      >
        <span aria-hidden className="ai-gradient-bg flex size-6 shrink-0 items-center justify-center rounded-full text-white [&>svg]:size-3.5">
          <Sparkles />
        </span>
        <span className="hidden min-w-0 flex-col items-start leading-none md:flex">
          <span className="max-w-40 truncate text-[13px] font-semibold text-foreground">{active.provider?.label ?? t('provider.none')}</span>
          <span className={['max-w-40 truncate text-[11px]', active.configured ? 'text-muted' : 'text-warning'].join(' ')}>
            {active.configured ? active.provider?.model || t('provider.defaultModel') : t(active.reasonKey ?? 'provider.reason.none')}
          </span>
        </span>
        <ChevronDown className="size-3.5 shrink-0 text-muted" />
      </Button>
      <Popover.Content placement="bottom end" className="w-[22rem] max-w-[calc(100vw-2rem)]">
        <Popover.Dialog className="p-2">
          <p className="px-2.5 pt-1.5 pb-2 text-[11px] font-semibold tracking-wide text-muted uppercase">{t('provider.title')}</p>
          {providers.length === 0 ? (
            <p className="px-2.5 py-3 text-xs text-muted">{t('provider.noneEnabled')}</p>
          ) : (
            <div role="menu" aria-label={t('provider.title')} className="flex flex-col gap-0.5">
              {providers.map((p) => {
                const readiness = providerReadiness(settings, p.id);
                const selected = p.id === settings.ai.activeProviderId;
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    disabled={!canControl || switching !== null}
                    onClick={() => void choose(p.id)}
                    className={[
                      'app-transition flex w-full items-start gap-3 rounded-xl p-2.5 text-start outline-none',
                      'hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-60',
                      selected ? 'bg-active' : '',
                    ].join(' ')}
                  >
                    <span aria-hidden className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-default text-muted [&>svg]:size-3.5">
                      {p.cloud ? <Cloud /> : <Cpu />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-semibold text-foreground">{p.label}</span>
                      <span className="mt-0.5 block truncate text-xs text-muted">
                        {p.model || t('provider.defaultModel')} · {p.cloud ? t('provider.cloud') : t('provider.local')}
                      </span>
                      {!readiness.configured && readiness.reasonKey ? (
                        <span className="mt-0.5 block text-xs text-warning">{t(readiness.reasonKey)}</span>
                      ) : null}
                    </span>
                    {switching === p.id ? (
                      <span className="mt-1 text-[11px] text-muted">{t('common.saving')}</span>
                    ) : selected ? (
                      <Check className="mt-1 size-4 shrink-0 text-accent" />
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}
          <div className="mt-1 border-t border-hairline px-1 pt-2">
            <Button
              size="sm"
              variant="ghost"
              fullWidth
              className="justify-start"
              onPress={() => {
                setOpen(false);
                navigate({ name: 'settings', section: 'ai' });
              }}
            >
              <Gear className="size-3.5" />
              {t('provider.manage')}
            </Button>
          </div>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
