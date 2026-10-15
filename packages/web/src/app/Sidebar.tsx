// Left navigation: sections with icons, active state, approval badges,
// collapse toggle and the keyboard-shortcuts entry.

import {
  ClockArrowRotateLeft,
  Gear,
  Keyboard,
  LayoutHeaderCellsLarge,
  LayoutSideContentLeft,
  Smartphone,
  Sparkles,
  Thunderbolt,
} from '@gravity-ui/icons';
import { Button, Tooltip } from '@heroui/react';
import type { ReactNode } from 'react';

import logoUrl from '../assets/logo.png';
import { KbdHint } from '../components/KbdHint';
import { MadeInDiriyah } from '../components/MadeInDiriyah';
import { useI18n } from '../lib/i18n';
import { navigate, SECTION_ORDER, type Route, type RouteName } from '../lib/router';
import { useAppStore } from '../state/store';

export interface NavItem {
  name: RouteName;
  labelKey: string;
  icon: ReactNode;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { name: 'dashboard', labelKey: 'nav.dashboard', icon: <LayoutHeaderCellsLarge /> },
  { name: 'live', labelKey: 'nav.live', icon: <Smartphone /> },
  { name: 'assistant', labelKey: 'nav.assistant', icon: <Sparkles /> },
  { name: 'automations', labelKey: 'nav.automations', icon: <Thunderbolt /> },
  { name: 'activity', labelKey: 'nav.activity', icon: <ClockArrowRotateLeft /> },
  { name: 'settings', labelKey: 'nav.settings', icon: <Gear /> },
];

export interface SidebarProps {
  route: Route;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onShowShortcuts: () => void;
}

function Badge({ count, collapsed, label }: { count: number; collapsed: boolean; label: string }) {
  if (count <= 0) return null;
  if (collapsed) {
    return <span aria-label={label} className="absolute top-1.5 end-1.5 size-2 rounded-full bg-warning ring-2 ring-surface" />;
  }
  return (
    <span aria-label={label} className="ms-auto min-w-5 rounded-full bg-warning px-1.5 text-center text-[11px] leading-5 font-semibold text-warning-foreground tabular-nums">
      {count > 99 ? '99+' : count}
    </span>
  );
}

export function Sidebar({ route, collapsed, onToggleCollapsed, onShowShortcuts }: SidebarProps) {
  const { t } = useI18n();
  const version = useAppStore((s) => s.version);
  const socket = useAppStore((s) => s.connection.socket);
  const taskApprovals = useAppStore((s) => s.approvals.filter((a) => !a.workflowRunId).length);
  const workflowApprovals = useAppStore((s) => s.approvals.filter((a) => a.workflowRunId).length);
  const badges: Partial<Record<RouteName, number>> = { assistant: taskApprovals, automations: workflowApprovals };

  return (
    <nav
      aria-label={t('nav.label')}
      className={[
        'app-transition flex h-full shrink-0 flex-col border-e border-hairline bg-surface/60',
        collapsed ? 'w-[68px]' : 'w-[232px]',
      ].join(' ')}
    >
      <div className={['flex h-14 items-center gap-2.5 border-b border-hairline', collapsed ? 'justify-center px-2' : 'px-4'].join(' ')}>
        <img
          src={logoUrl}
          alt=""
          aria-hidden
          draggable={false}
          className="h-[26px] w-auto shrink-0 select-none drop-shadow-[0_2px_8px_rgb(47_107_234/0.35)]"
        />
        {!collapsed ? (
          <div className="min-w-0 leading-tight">
            <p className="truncate text-[14px] font-semibold tracking-tight text-foreground">{t('app.name')}</p>
            <p className="truncate text-[11px] text-muted">{t('app.tagline')}</p>
          </div>
        ) : null}
      </div>

      <ul className="flex flex-1 flex-col gap-0.5 p-2.5">
        {NAV_ITEMS.map((item) => {
          const active = route.name === item.name;
          const index = SECTION_ORDER.indexOf(item.name) + 1;
          const label = t(item.labelKey);
          const count = badges[item.name] ?? 0;
          const button = (
            <Button
              variant="ghost"
              fullWidth
              aria-current={active ? 'page' : undefined}
              aria-label={collapsed ? label : undefined}
              onPress={() => navigate({ name: item.name })}
              className={[
                'app-transition relative h-10 rounded-xl text-[13px] font-medium',
                collapsed ? 'justify-center px-0' : 'justify-start gap-3 px-3',
                active ? 'bg-active text-foreground' : 'text-muted hover:bg-hover hover:text-foreground',
              ].join(' ')}
            >
              {active ? <span aria-hidden className="absolute inset-y-2.5 start-0 w-[3px] rounded-full bg-accent" /> : null}
              <span aria-hidden className={['flex size-5 shrink-0 items-center justify-center [&>svg]:size-[18px]', active ? 'text-accent' : ''].join(' ')}>
                {item.icon}
              </span>
              {!collapsed ? <span className="truncate">{label}</span> : null}
              <Badge count={count} collapsed={collapsed} label={t('nav.pendingApprovals', { count })} />
            </Button>
          );
          return (
            <li key={item.name}>
              <Tooltip delay={collapsed ? 150 : 800} closeDelay={0}>
                {button}
                <Tooltip.Content placement="end" className="text-xs">
                  <span className="flex items-center gap-2">
                    {label}
                    <KbdHint keys={['mod', String(index)]} />
                  </span>
                </Tooltip.Content>
              </Tooltip>
            </li>
          );
        })}
      </ul>

      <div className="px-2.5 pb-2">
        <MadeInDiriyah collapsed={collapsed} />
      </div>

      <div className={['flex flex-col gap-1 border-t border-hairline p-2.5', collapsed ? 'items-center' : ''].join(' ')}>
        <div className={['flex items-center gap-1', collapsed ? 'flex-col' : ''].join(' ')}>
          <Tooltip delay={300}>
            <Button isIconOnly variant="ghost" size="sm" aria-label={t('shortcuts.title')} onPress={onShowShortcuts} className="text-muted">
              <Keyboard className="size-4" />
            </Button>
            <Tooltip.Content placement={collapsed ? 'end' : 'top'} className="text-xs">
              <span className="flex items-center gap-2">
                {t('shortcuts.title')}
                <KbdHint keys={['?']} />
              </span>
            </Tooltip.Content>
          </Tooltip>
          <Tooltip delay={300}>
            <Button
              isIconOnly
              variant="ghost"
              size="sm"
              aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
              aria-expanded={!collapsed}
              onPress={onToggleCollapsed}
              className="text-muted"
            >
              <LayoutSideContentLeft className="size-4 rtl:-scale-x-100" />
            </Button>
            <Tooltip.Content placement={collapsed ? 'end' : 'top'} className="text-xs">
              {collapsed ? t('nav.expand') : t('nav.collapse')}
            </Tooltip.Content>
          </Tooltip>
          {!collapsed ? (
            <span className="ms-auto flex items-center gap-1.5 truncate text-[11px] text-muted" title={t(`connection.${socket}`)}>
              <span aria-hidden className={['status-dot', socket === 'open' ? 'text-success' : 'text-warning status-dot--pulse'].join(' ')} />
              {version ? `v${version}` : t(`connection.${socket}`)}
            </span>
          ) : null}
        </div>
      </div>
    </nav>
  );
}
