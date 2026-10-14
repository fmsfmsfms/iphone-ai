// Advanced: debug logging, MCP trace, Mirroir restart, diagnostics export,
// Mirroir's stderr tail, the discovered MCP tools and developer information.

import { ArrowDownToLine, ArrowsRotateRight, Code, Copy, PlugConnection, Terminal, Wrench } from '@gravity-ui/icons';
import type { McpToolInfo } from '@iphone-ai/shared';
import { Button, Spinner, Table } from '@heroui/react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { KeyValueList } from '../../components/KeyValue';
import { Panel } from '../../components/Panel';
import { StatusChip } from '../../components/StatusChip';
import { api, errorMessage, type DiagnosticsInfo } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { notify, notifyError, restartMcp, useSettings } from '../../state/store';
import { fileStamp, saveApiDownload } from '../activity/download';
import { FieldError, Rows, SettingRow, SwitchRow, useEditable } from './fields';
import { SectionFrame, useSectionAccess } from './SectionFrame';
import { SavedIndicator, useImmediateSave } from './useImmediateSave';

/** Loads once on mount; `load` refreshes. The loader may be an inline function. */
function useLoader<T>(fn: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fnRef.current());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, error, loading, load };
}

function RefreshButton({ loading, onPress, label }: { loading: boolean; onPress: () => void; label: string }) {
  return (
    <Button size="sm" variant="ghost" isPending={loading} onPress={onPress}>
      {loading ? null : <ArrowsRotateRight className="size-3.5" />}
      {label}
    </Button>
  );
}

function MaintenancePanel() {
  const { t } = useI18n();
  const editable = useEditable();
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [exporting, setExporting] = useState(false);
  const exportDiagnostics = async () => {
    setExporting(true);
    try {
      const name = await saveApiDownload(api.diagnostics.exportUrl(), `iphone-ai-diagnostics-${fileStamp()}.json`);
      notify('success', t('settings.advanced.export.saved'), t('settings.advanced.export.savedBody', { name }));
    } catch (err) {
      notifyError(t('settings.advanced.export.failed'), err);
    } finally {
      setExporting(false);
    }
  };
  return (
    <Panel title={t('settings.advanced.maintenance.title')}>
      <Rows>
        <SettingRow label={t('settings.advanced.restart.label')} description={t('settings.advanced.restart.description')}>
          <Button size="sm" variant="secondary" isDisabled={!editable} onPress={() => setConfirmRestart(true)}>
            <PlugConnection className="size-3.5" />
            {t('settings.connection.actions.restart')}
          </Button>
        </SettingRow>
        <SettingRow label={t('settings.advanced.export.label')} description={t('settings.advanced.export.hint')}>
          <Button size="sm" variant="secondary" isPending={exporting} onPress={() => void exportDiagnostics()}>
            {exporting ? null : <ArrowDownToLine className="size-3.5" />}
            {t('settings.advanced.export.button')}
          </Button>
        </SettingRow>
      </Rows>
      <ConfirmDialog
        isOpen={confirmRestart}
        onOpenChange={setConfirmRestart}
        title={t('settings.connection.restart.title')}
        confirmLabel={t('settings.connection.restart.confirm')}
        tone="warning"
        icon={<PlugConnection />}
        onConfirm={async () => {
          await restartMcp();
          notify('success', t('viewer.restart.done'));
        }}
      >
        <p>{t('settings.connection.restart.body')}</p>
      </ConfirmDialog>
    </Panel>
  );
}

function StderrPanel() {
  const { t } = useI18n();
  const { data, error, loading, load } = useLoader(() => api.connection.stderr());
  return (
    <Panel
      icon={<Terminal />}
      title={t('settings.advanced.stderr.title')}
      description={t('settings.advanced.stderr.description')}
      actions={<RefreshButton loading={loading} onPress={() => void load()} label={t('settings.advanced.refresh')} />}
    >
      {error ? (
        <FieldError message={error} />
      ) : data === null ? (
        <Spinner size="sm" />
      ) : data.length === 0 ? (
        <p className="text-[13px] text-muted">{t('settings.advanced.stderr.empty')}</p>
      ) : (
        <pre
          dir="ltr"
          tabIndex={0}
          aria-label={t('settings.advanced.stderr.title')}
          className="app-scroll max-h-80 rounded-xl border border-hairline bg-black/40 p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-foreground/85"
        >
          {data.join('\n')}
        </pre>
      )}
    </Panel>
  );
}

function ToolsPanel() {
  const { t } = useI18n();
  const { data, error, loading, load } = useLoader(() => api.connection.tools());
  const tools: McpToolInfo[] = data ? [...data].sort((a, b) => Number(b.mutating) - Number(a.mutating) || a.name.localeCompare(b.name)) : [];
  return (
    <Panel
      icon={<Code />}
      title={t('settings.advanced.tools.title')}
      description={t('settings.advanced.tools.description')}
      actions={<RefreshButton loading={loading} onPress={() => void load()} label={t('settings.advanced.refresh')} />}
    >
      {error ? (
        <FieldError message={error} />
      ) : data === null ? (
        <Spinner size="sm" />
      ) : tools.length === 0 ? (
        <p className="text-[13px] text-muted">{t('settings.advanced.tools.empty')}</p>
      ) : (
        <Table variant="secondary">
          <Table.ScrollContainer className="app-scroll max-h-[28rem]">
            <Table.Content aria-label={t('settings.advanced.tools.title')} className="min-w-[560px]">
              <Table.Header>
                <Table.Column isRowHeader>{t('settings.advanced.tools.name')}</Table.Column>
                <Table.Column>{t('settings.advanced.tools.kind')}</Table.Column>
                <Table.Column>{t('settings.advanced.tools.descriptionColumn')}</Table.Column>
              </Table.Header>
              <Table.Body>
                {tools.map((tool) => (
                  <Table.Row key={tool.name} id={tool.name}>
                    <Table.Cell>
                      <code dir="ltr" className="font-mono text-[12px] text-foreground">
                        {tool.name}
                      </code>
                    </Table.Cell>
                    <Table.Cell>
                      <StatusChip
                        size="sm"
                        tone={tool.mutating ? 'warning' : 'default'}
                        label={tool.mutating ? t('settings.advanced.tools.mutating') : t('settings.advanced.tools.readOnly')}
                      />
                    </Table.Cell>
                    <Table.Cell>
                      <span className="line-clamp-3 text-xs leading-relaxed text-muted" title={tool.description}>
                        {tool.description}
                      </span>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      )}
      {data ? <p className="mt-3 text-xs text-muted">{t('settings.advanced.tools.count', { count: tools.length, mutating: tools.filter((x) => x.mutating).length })}</p> : null}
    </Panel>
  );
}

function DeveloperPanel() {
  const { t } = useI18n();
  const { data, error, loading, load } = useLoader<DiagnosticsInfo>(() => api.diagnostics.info());
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notify('success', t('settings.advanced.info.copied'));
    } catch (err) {
      notifyError(t('settings.advanced.info.copyFailed'), err);
    }
  };
  return (
    <Panel
      icon={<Wrench />}
      title={t('settings.advanced.info.title')}
      actions={<RefreshButton loading={loading} onPress={() => void load()} label={t('settings.advanced.refresh')} />}
    >
      {error ? (
        <FieldError message={error} />
      ) : !data ? (
        <Spinner size="sm" />
      ) : (
        <KeyValueList
          items={[
            { key: 'version', label: t('settings.advanced.info.version'), value: <bdi dir="ltr">{data.version}</bdi>, mono: true },
            { key: 'mirroir', label: t('settings.advanced.info.mirroirVersion'), value: <bdi dir="ltr">{data.mirroirVersion ?? t('settings.connection.status.unknown')}</bdi>, mono: true },
            { key: 'binary', label: t('settings.advanced.info.mirroirBinary'), value: <bdi dir="ltr">{data.mirroirBinary}</bdi>, mono: true },
            { key: 'node', label: t('settings.advanced.info.node'), value: <bdi dir="ltr">{data.node}</bdi>, mono: true },
            { key: 'platform', label: t('settings.advanced.info.platform'), value: <bdi dir="ltr">{`${data.platform} · ${data.arch}`}</bdi>, mono: true },
            {
              key: 'data',
              label: t('settings.advanced.info.dataDir'),
              value: (
                <span className="inline-flex items-start gap-1.5">
                  <span className="font-mono text-[12px] break-all">{data.dataDir}</span>
                  <Button size="sm" variant="ghost" isIconOnly className="-mt-1 size-7 min-w-7" aria-label={t('settings.advanced.info.copyPath')} onPress={() => void copy(data.dataDir)}>
                    <Copy className="size-3.5" />
                  </Button>
                </span>
              ),
              hint: t('settings.advanced.info.dataDirHint'),
            },
          ]}
        />
      )}
    </Panel>
  );
}

export function AdvancedSection() {
  const { t } = useI18n();
  const settings = useSettings();
  const access = useSectionAccess('local');
  const { pending, savedAt, save } = useImmediateSave();
  if (!settings) return null;
  const advanced = settings.advanced;
  return (
    <SectionFrame
      title={t('settings.advanced.title')}
      description={t('settings.advanced.description')}
      icon={<Wrench />}
      access={access}
      actions={<SavedIndicator at={savedAt} />}
    >
      <Panel title={t('settings.advanced.logging.title')}>
        <Rows>
          <SwitchRow
            label={t('settings.advanced.debug.label')}
            description={t('settings.advanced.debug.description')}
            isSelected={advanced.debugLogging}
            isPending={pending === 'debug'}
            onChange={(debugLogging) => void save('debug', { advanced: { debugLogging } })}
          />
          <SwitchRow
            label={t('settings.advanced.trace.label')}
            description={t('settings.advanced.trace.description')}
            isSelected={advanced.mcpTrace}
            isPending={pending === 'trace'}
            onChange={(mcpTrace) => void save('trace', { advanced: { mcpTrace } })}
          />
        </Rows>
      </Panel>
      <MaintenancePanel />
      <StderrPanel />
      <ToolsPanel />
      <DeveloperPanel />
    </SectionFrame>
  );
}
