// Remote Access (optional): passcode, private-network listener, remote
// control permission and active sessions. The Mac stays the control host.

import { ArrowsRotateRight, BroadcastSignal, Copy, Key, PersonXmark, Persons, ShieldExclamation, TriangleExclamationFill } from '@gravity-ui/icons';
import { Button, Spinner, Table } from '@heroui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/EmptyState';
import { Panel } from '../../components/Panel';
import { RelativeTime } from '../../components/RelativeTime';
import { StatusChip } from '../../components/StatusChip';
import { api, errorMessage, type RemoteInfo, type RemoteSessionInfo } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { notify, notifyError, useSettings } from '../../state/store';
import { classifyIPv4, errorFor, MIN_PASSCODE_LENGTH, passcodeProblem, remoteUrlFor, type AddressKind } from './helpers';
import { FieldError, Notice, NumberRow, Rows, SaveBar, SelectInput, SettingRow, SwitchRow, TextInput, useEditable } from './fields';
import { SectionFrame, useSectionAccess } from './SectionFrame';
import { SavedIndicator, useImmediateSave } from './useImmediateSave';
import { useSectionForm } from './useSectionForm';

/** The backend also reports why the listener isn't running (not yet in the web API types). */
type RemoteInfoWithError = RemoteInfo & { error?: string | null };

const ADDRESS_TONE: Record<AddressKind, 'success' | 'accent' | 'warning' | 'danger' | 'default'> = {
  tailscale: 'success',
  private: 'accent',
  'link-local': 'default',
  loopback: 'default',
  public: 'danger',
  invalid: 'danger',
};

function useRemoteInfo() {
  const [info, setInfo] = useState<RemoteInfoWithError | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setInfo(await api.remote.get());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);
  return { info, error, loading, load };
}

function PasscodePanel({ passcodeSet, onChanged }: { passcodeSet: boolean; onChanged: () => void }) {
  const { t } = useI18n();
  const editable = useEditable();
  const [open, setOpen] = useState(false);
  const [passcode, setPasscode] = useState('');
  const [confirm, setConfirm] = useState('');
  const problem = passcodeProblem(passcode, confirm);
  const showProblem = (passcode.length > 0 && passcode.length < MIN_PASSCODE_LENGTH) || (confirm.length > 0 && problem !== null);

  return (
    <Panel icon={<Key />} title={t('settings.remote.passcode.title')} description={t('settings.remote.passcode.description')}>
      <SettingRow label={t('settings.remote.passcode.label')} badge={<StatusChip size="sm" tone={passcodeSet ? 'success' : 'warning'} label={passcodeSet ? t('settings.remote.passcode.set') : t('settings.remote.passcode.notSet')} />}>
        <Button size="sm" variant="secondary" isDisabled={!editable} onPress={() => setOpen(true)}>
          {passcodeSet ? t('settings.remote.passcode.change') : t('settings.remote.passcode.setButton')}
        </Button>
      </SettingRow>
      <ConfirmDialog
        isOpen={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setPasscode('');
            setConfirm('');
          }
        }}
        title={passcodeSet ? t('settings.remote.passcode.changeTitle') : t('settings.remote.passcode.setTitle')}
        confirmLabel={t('settings.remote.passcode.save')}
        icon={<Key />}
        isConfirmDisabled={problem !== null}
        onConfirm={async () => {
          await api.remote.setPasscode(passcode);
          notify('success', t('settings.remote.passcode.saved'));
          onChanged();
        }}
      >
        <div className="flex flex-col gap-3 text-start">
          <p>{t('settings.remote.passcode.dialogBody', { min: MIN_PASSCODE_LENGTH })}</p>
          {passcodeSet ? <p className="text-warning">{t('settings.remote.passcode.changeWarning')}</p> : null}
          <TextInput showLabel label={t('settings.remote.passcode.new')} value={passcode} onChange={setPasscode} type="password" autoComplete="new-password" maxLength={128} />
          <TextInput showLabel label={t('settings.remote.passcode.repeat')} value={confirm} onChange={setConfirm} type="password" autoComplete="new-password" maxLength={128} />
          {showProblem && problem ? <FieldError message={t(problem, { min: MIN_PASSCODE_LENGTH })} /> : null}
        </div>
      </ConfirmDialog>
    </Panel>
  );
}

function SessionsPanel() {
  const { t, locale } = useI18n();
  const editable = useEditable();
  const [sessions, setSessions] = useState<RemoteSessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSessions(await api.remote.sessions());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (session: RemoteSessionInfo) => {
    setRevoking(session.id);
    try {
      await api.remote.revokeSession(session.id);
      notify('success', t('settings.remote.sessions.revoked'));
      await load();
    } catch (err) {
      notifyError(t('settings.remote.sessions.revokeFailed'), err);
    } finally {
      setRevoking(null);
    }
  };

  const active = (sessions ?? []).filter((s) => s.revokedAt === null && s.expiresAt > Date.now());
  const revocable = active.filter((s) => s.kind !== 'desktop' && !s.current);

  return (
    <Panel
      icon={<Persons />}
      title={t('settings.remote.sessions.title')}
      description={t('settings.remote.sessions.description')}
      actions={
        <>
          <Button size="sm" variant="ghost" isPending={loading} onPress={() => void load()} aria-label={t('settings.remote.sessions.refresh')}>
            {loading ? null : <ArrowsRotateRight className="size-3.5" />}
            {t('settings.remote.sessions.refresh')}
          </Button>
          <Button size="sm" variant="ghost" className="text-danger" isDisabled={!editable || revocable.length === 0} onPress={() => setConfirmAll(true)}>
            {t('settings.remote.sessions.revokeAll')}
          </Button>
        </>
      }
    >
      {error ? (
        <FieldError message={error} />
      ) : sessions === null ? (
        <Spinner size="sm" />
      ) : active.length === 0 ? (
        <EmptyState size="sm" icon={<Persons />} title={t('settings.remote.sessions.empty')} />
      ) : (
        <Table variant="secondary">
          <Table.ScrollContainer>
            <Table.Content aria-label={t('settings.remote.sessions.title')} className="min-w-[560px]">
              <Table.Header>
                <Table.Column isRowHeader>{t('settings.remote.sessions.device')}</Table.Column>
                <Table.Column>{t('settings.remote.sessions.ip')}</Table.Column>
                <Table.Column>{t('settings.remote.sessions.lastSeen')}</Table.Column>
                <Table.Column>{t('settings.remote.sessions.control')}</Table.Column>
                <Table.Column>
                  <span className="sr-only">{t('settings.remote.sessions.actions')}</span>
                </Table.Column>
              </Table.Header>
              <Table.Body>
                {active.map((session) => (
                  <Table.Row key={session.id} id={session.id}>
                    <Table.Cell>
                      <span className="flex flex-col">
                        <span dir="auto" className="text-[13px] font-medium text-foreground">
                          {session.deviceName ??
                            (session.kind === 'remote' ? t('settings.remote.sessions.unnamed') : t(`settings.remote.sessions.kinds.${session.kind}`))}
                          {session.current ? <span className="ms-1.5 text-xs text-accent">({t('settings.remote.sessions.thisDevice')})</span> : null}
                        </span>
                        <span className="text-[11px] text-muted">
                          {session.deviceName ? `${t(`settings.remote.sessions.kinds.${session.kind}`)} · ` : ''}
                          {t('settings.remote.sessions.expires', { when: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(session.expiresAt) })}
                        </span>
                      </span>
                    </Table.Cell>
                    <Table.Cell>
                      <code dir="ltr" className="font-mono text-[12px]">
                        {session.ip ?? '—'}
                      </code>
                    </Table.Cell>
                    <Table.Cell>
                      <RelativeTime at={session.lastSeenAt} className="text-[12px]" />
                    </Table.Cell>
                    <Table.Cell>
                      <StatusChip
                        size="sm"
                        tone={session.canControl ? 'warning' : 'default'}
                        label={session.canControl ? t('settings.remote.sessions.canControl') : t('settings.remote.sessions.viewOnly')}
                      />
                    </Table.Cell>
                    <Table.Cell>
                      {session.kind !== 'desktop' && !session.current ? (
                        <Button size="sm" variant="ghost" className="text-danger" isDisabled={!editable} isPending={revoking === session.id} onPress={() => void revoke(session)}>
                          <PersonXmark className="size-3.5" />
                          {t('settings.remote.sessions.revoke')}
                        </Button>
                      ) : null}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      )}
      <ConfirmDialog
        isOpen={confirmAll}
        onOpenChange={setConfirmAll}
        title={t('settings.remote.sessions.revokeAllTitle')}
        confirmLabel={t('settings.remote.sessions.revokeAll')}
        tone="danger"
        icon={<PersonXmark />}
        onConfirm={async () => {
          const result = await api.remote.revokeAll();
          notify('success', t('settings.remote.sessions.revokedAll', { count: result.revoked }));
          await load();
        }}
      >
        <p>{t('settings.remote.sessions.revokeAllBody')}</p>
      </ConfirmDialog>
    </Panel>
  );
}

export function RemoteSection() {
  const { t } = useI18n();
  const settings = useSettings();
  const access = useSectionAccess('local');
  const form = useSectionForm('remote', ['enabled', 'allowRemoteControl', 'passcodeSet']);
  const { info, error: infoError, loading: infoLoading, load: loadInfo } = useRemoteInfo();
  const { pending, savedAt, save } = useImmediateSave();
  const [confirm, setConfirm] = useState<'enable' | 'control' | null>(null);

  useEffect(() => {
    void loadInfo();
  }, [loadInfo]);
  // The listener follows settings changes in the background: refresh its state shortly after they land.
  const remoteSettings = settings?.remote;
  const seenSettings = useRef(remoteSettings);
  useEffect(() => {
    if (!remoteSettings || seenSettings.current === remoteSettings) return;
    seenSettings.current = remoteSettings;
    const id = setTimeout(() => void loadInfo(), 600);
    return () => clearTimeout(id);
  }, [remoteSettings, loadInfo]);

  const draft = form.draft;
  const addresses = useMemo(() => info?.addresses ?? [], [info]);
  if (!draft || !remoteSettings) return null;

  const savedAddress = remoteSettings.bindAddress.trim();
  const addressKind = draft.bindAddress ? classifyIPv4(draft.bindAddress) : null;
  const addressAvailable = !draft.bindAddress || addresses.some((a) => a.address === draft.bindAddress);
  const enableReason = !remoteSettings.passcodeSet
    ? t('settings.remote.enable.needPasscode')
    : form.dirty
      ? t('settings.remote.enable.saveFirst')
      : !savedAddress
        ? t('settings.remote.enable.needAddress')
        : null;
  const url = info?.url ?? (savedAddress ? remoteUrlFor(savedAddress, remoteSettings.port) : null);

  const addressOptions = addresses.map((a) => {
    const kind = classifyIPv4(a.address);
    return {
      id: a.address,
      label: a.address,
      description: `${a.iface} · ${t(`settings.remote.address.kind.${a.tailscale ? 'tailscale' : kind}`)}`,
    };
  });
  if (draft.bindAddress && !addresses.some((a) => a.address === draft.bindAddress)) {
    addressOptions.unshift({ id: draft.bindAddress, label: draft.bindAddress, description: t('settings.remote.address.unavailable') });
  }

  const copyUrl = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      notify('success', t('settings.remote.url.copied'));
    } catch (err) {
      notifyError(t('settings.remote.url.copyFailed'), err);
    }
  };

  return (
    <SectionFrame
      title={t('settings.remote.title')}
      description={t('settings.remote.description')}
      icon={<BroadcastSignal />}
      access={access}
      actions={<SavedIndicator at={savedAt} />}
    >
      <Notice tone="ai" icon={<BroadcastSignal />} title={t('settings.remote.explain.title')}>
        <ul className="mt-1 flex list-disc flex-col gap-1 ps-4">
          <li>{t('settings.remote.explain.host')}</li>
          <li>{t('settings.remote.explain.private')}</li>
          <li>{t('settings.remote.explain.encryption')}</li>
          <li>{t('settings.remote.explain.status')}</li>
        </ul>
      </Notice>

      <PasscodePanel passcodeSet={remoteSettings.passcodeSet} onChanged={() => void loadInfo()} />

      <Panel
        title={t('settings.remote.listener.title')}
        description={t('settings.remote.listener.description')}
        actions={
          <StatusChip
            tone={info?.listening ? 'success' : remoteSettings.enabled ? 'warning' : 'default'}
            pulse={info?.listening}
            label={info?.listening ? t('settings.remote.listener.on') : remoteSettings.enabled ? t('settings.remote.listener.notRunning') : t('settings.remote.listener.off')}
          />
        }
      >
        <Rows>
          <SwitchRow
            label={t('settings.remote.enable.label')}
            description={t('settings.remote.enable.description')}
            isSelected={remoteSettings.enabled}
            isPending={pending === 'enabled'}
            isDisabled={!remoteSettings.enabled && enableReason !== null}
            disabledReason={!remoteSettings.enabled ? enableReason : null}
            onChange={(on) => {
              if (on) setConfirm('enable');
              else void save('enabled', { remote: { enabled: false } });
            }}
          />
          <SettingRow
            label={t('settings.remote.address.label')}
            description={t('settings.remote.address.description')}
            error={errorFor(form.errors, 'bindAddress')}
          >
            <div className="flex flex-wrap items-center gap-2">
              <SelectInput
                label={t('settings.remote.address.label')}
                value={draft.bindAddress || null}
                placeholder={addresses.length ? t('settings.remote.address.choose') : t('settings.remote.address.noneFound')}
                options={addressOptions}
                onChange={(v) => form.set('bindAddress', v)}
              />
              {addressKind ? <StatusChip size="sm" tone={ADDRESS_TONE[addressKind]} label={t(`settings.remote.address.kind.${addressKind}`)} /> : null}
              <Button size="sm" variant="ghost" isIconOnly aria-label={t('settings.remote.address.refresh')} isPending={infoLoading} onPress={() => void loadInfo()}>
                {infoLoading ? null : <ArrowsRotateRight className="size-3.5" />}
              </Button>
            </div>
          </SettingRow>
          <NumberRow
            label={t('settings.remote.port.label')}
            description={t('settings.remote.port.description')}
            value={draft.port}
            onChange={(v) => form.set('port', v ?? Number.NaN)}
            minValue={1024}
            maxValue={65535}
            error={errorFor(form.errors, 'port')}
          />
          <NumberRow
            label={t('settings.remote.ttl.label')}
            description={t('settings.remote.ttl.description')}
            value={draft.sessionTtlHours}
            onChange={(v) => form.set('sessionTtlHours', v ?? Number.NaN)}
            minValue={1}
            maxValue={720}
            unit={t('settings.unit.hours')}
            error={errorFor(form.errors, 'sessionTtlHours')}
          />
          <SwitchRow
            label={t('settings.remote.control.label')}
            description={t('settings.remote.control.description')}
            isSelected={remoteSettings.allowRemoteControl}
            isPending={pending === 'control'}
            onChange={(on) => {
              if (on) setConfirm('control');
              else void save('control', { remote: { allowRemoteControl: false } });
            }}
          />
        </Rows>

        <div className="mt-3 flex flex-col gap-2.5">
          {addressKind === 'tailscale' ? <Notice tone="success">{t('settings.remote.address.tailscaleNote')}</Notice> : null}
          {addressKind === 'public' ? (
            <Notice tone="danger" icon={<ShieldExclamation />} title={t('settings.remote.address.publicTitle')}>
              {t('settings.remote.address.publicBody')}
            </Notice>
          ) : null}
          {addressKind === 'private' || addressKind === 'link-local' ? <Notice tone="warning">{t('settings.remote.address.lanNote')}</Notice> : null}
          {!addressAvailable ? <Notice tone="warning">{t('settings.remote.address.unavailableNote')}</Notice> : null}
          {infoError ? <FieldError message={infoError} /> : null}
          {remoteSettings.enabled && !info?.listening && info?.error ? (
            <Notice tone="warning" icon={<TriangleExclamationFill />} title={t('settings.remote.listener.problem')}>
              <span dir="auto">{info.error}</span>
            </Notice>
          ) : null}
        </div>

        <div className="mt-4 rounded-xl border border-hairline bg-surface-secondary p-3">
          <p className="text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">{t('settings.remote.url.title')}</p>
          {url ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <code dir="ltr" className="font-mono text-[13px] break-all text-foreground">
                {url}
              </code>
              <Button size="sm" variant="ghost" isIconOnly aria-label={t('settings.remote.url.copy')} onPress={() => void copyUrl()}>
                <Copy className="size-3.5" />
              </Button>
            </div>
          ) : (
            <p className="mt-1 text-xs text-muted">{t('settings.remote.url.none')}</p>
          )}
          <p className="mt-1.5 text-xs leading-relaxed text-muted">
            {info?.listening ? t('settings.remote.url.hintOn') : t('settings.remote.url.hintOff')}
          </p>
        </div>

        <SaveBar dirty={form.dirty} status={form.status} error={form.generalError} onSave={() => void form.save()} onDiscard={form.discard} />
      </Panel>

      <SessionsPanel />

      <ConfirmDialog
        isOpen={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={confirm === 'control' ? t('settings.remote.control.confirmTitle') : t('settings.remote.enable.confirmTitle')}
        confirmLabel={confirm === 'control' ? t('settings.remote.control.confirm') : t('settings.remote.enable.confirm')}
        tone="warning"
        icon={<BroadcastSignal />}
        size="md"
        onConfirm={async () => {
          if (confirm === 'control') await save('control', { remote: { allowRemoteControl: true } }, { rethrow: true });
          else await save('enabled', { remote: { enabled: true } }, { rethrow: true });
          void loadInfo();
        }}
      >
        {confirm === 'control' ? (
          <div className="flex flex-col gap-2">
            <p className="text-foreground">{t('settings.remote.control.confirmBody')}</p>
            <p>{t('settings.remote.control.confirmBody2')}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-foreground">{t('settings.remote.enable.confirmBody', { url: savedAddress ? remoteUrlFor(savedAddress, remoteSettings.port) : '' })}</p>
            <p>{t('settings.remote.enable.confirmBody2')}</p>
          </div>
        )}
      </ConfirmDialog>
    </SectionFrame>
  );
}
