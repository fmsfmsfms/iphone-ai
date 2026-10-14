// Activity History: the audit log of everything done through iPhone AI,
// grouped by day, filterable, live-updating, exportable and clearable.

import { ArrowDownToLine, ArrowsRotateRight, ClockArrowRotateLeft, FileArrowDown, FileText, TrashBin, TriangleExclamationFill } from '@gravity-ui/icons';
import type { ActivityEvent } from '@iphone-ai/shared';
import { Button, Description, Dropdown, Label, Separator, Skeleton, Spinner } from '@heroui/react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/EmptyState';
import { IconButton } from '../../components/IconButton';
import { Page } from '../../components/Page';
import { Panel } from '../../components/Panel';
import { useNow } from '../../components/RelativeTime';
import { StatusChip } from '../../components/StatusChip';
import { api } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { notify, notifyError, useAppStore, useConnection, useSession } from '../../state/store';
import { ActivityDetailDrawer } from './ActivityDetailDrawer';
import { ActivityFilterBar } from './ActivityFilterBar';
import { ActivityTimeline } from './ActivityTimeline';
import { fileStamp, saveApiDownload } from './download';
import { EMPTY_FILTERS, filtersToQuery, hasActiveFilters, parseActivityHashParams, type ActivityFilters } from './helpers';
import './messages';
import { useActivityFeed } from './useActivityFeed';

const SEARCH_DEBOUNCE_MS = 300;

function initialFilters(): ActivityFilters {
  const { taskId } = parseActivityHashParams(typeof window === 'undefined' ? '' : window.location.hash);
  return { ...EMPTY_FILTERS, taskId };
}

function ExportMenu({ filters }: { filters: ActivityFilters }) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);

  const run = async (kind: 'json' | 'csv' | 'diagnostics') => {
    setPending(true);
    try {
      const name =
        kind === 'diagnostics'
          ? await saveApiDownload(api.diagnostics.exportUrl(), `iphone-ai-diagnostics-${fileStamp()}.json`)
          : await saveApiDownload(api.activity.exportUrl(kind, filtersToQuery(filters)), `iphone-ai-activity-${fileStamp()}.${kind}`);
      notify('success', t('activity.export.saved'), t('activity.export.savedBody', { name }));
    } catch (err) {
      notifyError(t('activity.export.failed'), err);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dropdown>
      <Button size="sm" variant="secondary" isPending={pending}>
        {pending ? null : <ArrowDownToLine className="size-3.5" />}
        {t('activity.export.label')}
      </Button>
      <Dropdown.Popover placement="bottom end" className="w-80 max-w-[calc(100vw-2rem)]">
        <Dropdown.Menu aria-label={t('activity.export.label')} onAction={(key) => void run(key as 'json' | 'csv' | 'diagnostics')}>
          <Dropdown.Item id="json" textValue={t('activity.export.json')}>
            <FileText className="size-4 shrink-0 text-muted" />
            <Label>{t('activity.export.json')}</Label>
          </Dropdown.Item>
          <Dropdown.Item id="csv" textValue={t('activity.export.csv')}>
            <FileArrowDown className="size-4 shrink-0 text-muted" />
            <div className="flex flex-col">
              <Label>{t('activity.export.csv')}</Label>
              <Description>{t('activity.export.csvHint')}</Description>
            </div>
          </Dropdown.Item>
          <Dropdown.Item id="diagnostics" textValue={t('activity.export.diagnostics')}>
            <ArrowDownToLine className="size-4 shrink-0 text-muted" />
            <div className="flex flex-col">
              <Label>{t('activity.export.diagnostics')}</Label>
              <Description>{t('activity.export.diagnosticsHint')}</Description>
            </div>
          </Dropdown.Item>
        </Dropdown.Menu>
        <Separator />
        <p className="px-3 py-2 text-[11px] leading-relaxed text-muted">{t('activity.export.filtersNote')}</p>
      </Dropdown.Popover>
    </Dropdown>
  );
}

export default function ActivityPage() {
  const { t } = useI18n();
  const session = useSession();
  const canControl = useAppStore((s) => s.session?.canControl ?? s.hello?.canControl ?? false);
  const socket = useConnection().socket;
  const now = useNow(60_000);

  const [filters, setFilters] = useState<ActivityFilters>(initialFilters);
  const [searchInput, setSearchInput] = useState('');
  const [selected, setSelected] = useState<ActivityEvent | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Debounce free-text search.
  useEffect(() => {
    const id = setTimeout(() => {
      setFilters((f) => (f.search === searchInput.trim() ? f : { ...f, search: searchInput.trim() }));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [searchInput]);

  // Follow `#/activity?taskId=…` links opened while this page is showing.
  useEffect(() => {
    const onHash = () => {
      if (!window.location.hash.startsWith('#/activity')) return;
      const { taskId } = parseActivityHashParams(window.location.hash);
      setFilters((f) => (f.taskId === taskId ? f : { ...f, taskId }));
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const updateFilters = useCallback((next: ActivityFilters) => {
    setFilters(next);
    // Keep the address in sync when the task filter is removed, so a reload doesn't bring it back.
    if (!next.taskId && window.location.hash.includes('?')) {
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#/activity`);
    }
  }, []);

  const feed = useActivityFeed(filters);
  const filtered = hasActiveFilters(filters);
  const isLocal = session ? !session.remote : true;
  const deleteReason = !isLocal ? t('activity.delete.localOnly') : !canControl ? t('activity.delete.viewOnly') : null;

  const selectedEvent = useMemo(() => (selected ? (feed.events.find((e) => e.id === selected.id) ?? selected) : null), [feed.events, selected]);

  // Errors stay in the confirmation dialog (it shows them and remains open).
  const deleteHistory = async () => {
    const result = await api.activity.clear();
    notify('success', t('activity.delete.done'), t('activity.delete.doneBody', { count: result.deleted }));
    setSelected(null);
    void feed.reload();
  };

  const live = socket === 'open';

  return (
    <Page
      title={t('activity.title')}
      description={t('activity.description')}
      icon={<ClockArrowRotateLeft />}
      actions={
        <>
          <StatusChip
            tone={live ? 'success' : 'warning'}
            pulse={live}
            label={live ? t('activity.live') : t('activity.offline')}
            tooltip={live ? t('activity.liveHint') : t('activity.offlineHint')}
          />
          <ExportMenu filters={filters} />
          <IconButton
            label={t('activity.delete.button')}
            icon={<TrashBin />}
            showLabel
            variant="ghost"
            className="text-danger"
            isDisabled={deleteReason !== null}
            disabledReason={deleteReason}
            onPress={() => setConfirmDelete(true)}
          />
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Panel bodyClassName="flex flex-col gap-3">
          <ActivityFilterBar filters={filters} searchInput={searchInput} onSearchInput={setSearchInput} onChange={updateFilters} />
        </Panel>

        <div aria-live="polite" aria-busy={feed.status === 'loading'} className={['app-transition', feed.refreshing ? 'opacity-60' : ''].join(' ')}>
          {feed.status === 'loading' && feed.events.length === 0 ? (
            <div className="flex flex-col gap-2 px-1" aria-label={t('common.loading')}>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="flex items-center gap-3 px-3 py-2.5">
                  <Skeleton className="size-8 rounded-[10px]" />
                  <div className="flex flex-1 flex-col gap-1.5">
                    <Skeleton className="h-3.5 w-2/3 rounded-md" />
                    <Skeleton className="h-3 w-1/3 rounded-md" />
                  </div>
                </div>
              ))}
            </div>
          ) : feed.status === 'error' && feed.events.length === 0 ? (
            <Panel>
              <EmptyState
                tone="danger"
                icon={<TriangleExclamationFill />}
                title={t('activity.error.title')}
                description={feed.error}
                actions={
                  <Button size="sm" variant="secondary" onPress={() => void feed.reload()}>
                    <ArrowsRotateRight className="size-3.5" />
                    {t('activity.retry')}
                  </Button>
                }
              />
            </Panel>
          ) : feed.events.length === 0 ? (
            <Panel>
              <EmptyState
                size="lg"
                icon={<ClockArrowRotateLeft />}
                title={filtered ? t('activity.empty.filtered.title') : t('activity.empty.title')}
                description={filtered ? t('activity.empty.filtered.body') : t('activity.empty.body')}
                actions={
                  filtered ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onPress={() => {
                        setSearchInput('');
                        updateFilters(EMPTY_FILTERS);
                      }}
                    >
                      {t('activity.filters.clear')}
                    </Button>
                  ) : null
                }
              />
            </Panel>
          ) : (
            <>
              <ActivityTimeline events={feed.events} now={now} selectedId={selectedEvent?.id ?? null} onSelect={setSelected} />
              <div className="mt-4 flex flex-col items-center gap-2">
                {feed.hasMore ? (
                  <Button variant="secondary" size="sm" isPending={feed.loadingMore} onPress={() => void feed.loadMore()}>
                    {feed.loadingMore ? <Spinner size="sm" /> : null}
                    {t('activity.loadMore')}
                  </Button>
                ) : (
                  <p className="text-xs text-muted">{t('activity.end')}</p>
                )}
                {feed.loadMoreError ? (
                  <p role="alert" className="text-xs text-danger">
                    {t('activity.loadMoreFailed')}: {feed.loadMoreError}
                  </p>
                ) : null}
                {feed.status === 'error' && feed.error ? (
                  <p role="alert" className="text-xs text-danger">
                    {t('activity.error.title')}: {feed.error}
                  </p>
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>

      <ActivityDetailDrawer
        event={selectedEvent}
        onClose={() => setSelected(null)}
        onFilterTask={(taskId) => {
          setSelected(null);
          updateFilters({ ...filters, taskId });
        }}
      />

      <ConfirmDialog
        isOpen={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('activity.delete.title')}
        confirmLabel={t('activity.delete.confirm')}
        tone="danger"
        icon={<TrashBin />}
        onConfirm={deleteHistory}
      >
        <p>{t('activity.delete.body')}</p>
        <p className="mt-2">{t('activity.delete.body2')}</p>
      </ConfirmDialog>
    </Page>
  );
}
