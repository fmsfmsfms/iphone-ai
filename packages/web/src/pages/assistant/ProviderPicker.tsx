// Active AI provider + model for the conversation header. Switching calls
// PUT /api/providers/active and takes effect for the next instruction (no
// restart). Each provider shows vision/text-only and cloud/local badges.

import { Check, ChevronDown, Cloud, Cpu, Eye, Gear, Sparkles, Text } from '@gravity-ui/icons';
import type { ProviderConfig } from '@iphone-ai/shared';
import { Button, Description, Dropdown, Label, Separator } from '@heroui/react';
import { useState } from 'react';

import { StatusChip } from '../../components/StatusChip';
import { providerReadiness } from '../../lib/device-state';
import { useI18n } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { notifyError, setActiveProvider, useAppStore, useCanControl } from '../../state/store';

const MANAGE_KEY = '__manage';

export function ProviderBadges({ provider, size = 'sm', tooltips = true }: { provider: ProviderConfig; size?: 'sm' | 'md'; tooltips?: boolean }) {
  const { t } = useI18n();
  return (
    <span className="flex flex-wrap items-center gap-1">
      <StatusChip
        size={size}
        hideDot
        tone={provider.vision ? 'accent' : 'default'}
        icon={provider.vision ? <Eye /> : <Text />}
        label={provider.vision ? t('assistant.badge.vision') : t('assistant.badge.textOnly')}
        tooltip={tooltips ? (provider.vision ? t('assistant.badge.visionHint') : t('assistant.badge.textOnlyHint')) : undefined}
      />
      <StatusChip
        size={size}
        hideDot
        tone={provider.cloud ? 'default' : 'success'}
        icon={provider.cloud ? <Cloud /> : <Cpu />}
        label={provider.cloud ? t('assistant.badge.cloud') : t('assistant.badge.local')}
        tooltip={tooltips ? (provider.cloud ? t('assistant.badge.cloudHint') : t('assistant.badge.localHint')) : undefined}
      />
    </span>
  );
}

export function ProviderPicker() {
  const { t } = useI18n();
  const settings = useAppStore((s) => s.settings);
  const canControl = useCanControl();
  const busy = useAppStore((s) => s.activeTaskId !== null);
  const [switching, setSwitching] = useState(false);
  if (!settings) return null;

  const activeId = settings.ai.activeProviderId;
  const active = providerReadiness(settings);
  const providers = settings.ai.providers.filter((p) => p.enabled);

  const choose = async (id: string) => {
    if (id === activeId) return;
    setSwitching(true);
    try {
      await setActiveProvider(id);
    } catch (err) {
      notifyError(t('provider.switchFailed'), err);
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Dropdown>
        <Button
          variant="tertiary"
          size="sm"
          isPending={switching}
          isDisabled={!canControl}
          className="h-9 max-w-72 min-w-0 gap-2 rounded-full border border-hairline bg-surface ps-1.5 pe-3"
          aria-label={t('assistant.provider.trigger', { provider: active.provider?.label ?? t('provider.none') })}
        >
          <span aria-hidden className="ai-gradient-bg flex size-6 shrink-0 items-center justify-center rounded-full text-white [&>svg]:size-3.5">
            <Sparkles />
          </span>
          <span className="flex min-w-0 flex-col items-start leading-none">
            <span className="max-w-48 truncate text-[13px] font-semibold text-foreground">{active.provider?.label ?? t('provider.none')}</span>
            <span className={['max-w-48 truncate text-[11px]', active.configured ? 'text-muted' : 'text-warning'].join(' ')}>
              {active.configured ? active.provider?.model || t('provider.defaultModel') : t(active.reasonKey ?? 'provider.reason.none')}
            </span>
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-muted" />
        </Button>
        <Dropdown.Popover placement="bottom start" className="w-[24rem] max-w-[calc(100vw-2rem)]">
          <div className="px-3 pt-2.5 pb-1">
            <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">{t('assistant.provider.title')}</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted">{busy ? t('assistant.provider.nextTask') : t('assistant.provider.hint')}</p>
          </div>
          {providers.length === 0 ? <p className="px-3 py-2 text-xs text-muted">{t('provider.noneEnabled')}</p> : null}
          <Dropdown.Menu
            aria-label={t('assistant.provider.title')}
            onAction={(key) => {
              if (key === MANAGE_KEY) navigate({ name: 'settings', section: 'ai' });
              else void choose(String(key));
            }}
          >
            {providers.map((p) => {
              const readiness = providerReadiness(settings, p.id);
              const selected = p.id === activeId;
              return (
                <Dropdown.Item key={p.id} id={p.id} textValue={p.label} className={['items-start', selected ? 'bg-active' : ''].join(' ')}>
                  <span aria-hidden className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-default text-muted [&>svg]:size-3.5">
                    {p.cloud ? <Cloud /> : <Cpu />}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <Label className="truncate text-[13px] font-semibold">{p.label}</Label>
                    <Description className="truncate text-xs">{p.model || t('provider.defaultModel')}</Description>
                    <ProviderBadges provider={p} tooltips={false} />
                    {!readiness.configured && readiness.reasonKey ? <span className="text-xs text-warning">{t(readiness.reasonKey)}</span> : null}
                  </div>
                  {selected ? <Check aria-label={t('assistant.provider.selected')} className="mt-1 size-4 shrink-0 text-accent" /> : null}
                </Dropdown.Item>
              );
            })}
            {providers.length > 0 ? <Separator /> : null}
            <Dropdown.Item id={MANAGE_KEY} textValue={t('provider.manage')}>
              <Gear className="size-3.5 text-muted" />
              <Label className="text-[13px]">{t('provider.manage')}</Label>
            </Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
      {active.provider ? <ProviderBadges provider={active.provider} /> : null}
    </div>
  );
}
