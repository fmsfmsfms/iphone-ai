// Live Control: device panel | phone viewer | assistant, in three resizable
// panes whose layout is remembered. Shortcuts: R refresh, M manual control,
// T focus the type-text field.

import './messages';

import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { useRef } from 'react';

import { PhoneViewer } from '../../components/phone/PhoneViewer';
import { refreshScreen } from '../../components/phone/phone-actions';
import { isTypingTarget, useWindowKeydown } from '../../lib/hotkeys';
import { useI18n } from '../../lib/i18n';
import { safeStorage } from '../../lib/storage';
import { appStore, setUi } from '../../state/store';
import { AssistantPanel } from './AssistantPanel';
import { DevicePanel } from './DevicePanel';
import { useManualControl } from './useManualControl';

function hasOpenDialog(): boolean {
  return document.querySelector('[role="dialog"], [role="alertdialog"]') !== null;
}

export default function LivePage() {
  const { t, dir, isRTL } = useI18n();
  const manual = useManualControl();
  const typeFieldRef = useRef<HTMLInputElement>(null);
  const refreshing = useRef(false);
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: `live-control-${dir}`, storage: safeStorage });

  useWindowKeydown((e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    if (isTypingTarget(e.target) || hasOpenDialog()) return;
    const key = e.key.toLowerCase();
    if (key === 'r') {
      e.preventDefault();
      if (refreshing.current || !(appStore.getState().session?.canControl ?? false)) return;
      refreshing.current = true;
      void refreshScreen().finally(() => {
        refreshing.current = false;
      });
    } else if (key === 'm') {
      e.preventDefault();
      manual.toggle();
    } else if (key === 't') {
      e.preventDefault();
      typeFieldRef.current?.focus();
    }
  });

  const device = (
    <Panel key="device" id="device" defaultSize="300px" minSize="240px" maxSize="460px" collapsible collapsedSize="0px" className="min-w-0">
      <div dir={dir} className="h-full bg-surface/40">
        <DevicePanel manual={manual} typeFieldRef={typeFieldRef} />
      </div>
    </Panel>
  );
  const viewer = (
    <Panel key="viewer" id="viewer" minSize="300px" className="min-w-0">
      <section dir={dir} aria-label={t('live.viewer.title')} className="flex h-full min-h-0 flex-col px-5 pt-4 pb-4">
        <PhoneViewer interactive toolbar />
      </section>
    </Panel>
  );
  const assistant = (
    <Panel
      key="assistant"
      id="assistant"
      defaultSize="380px"
      minSize="300px"
      maxSize="600px"
      collapsible
      collapsedSize="0px"
      className="min-w-0"
      // Approval toasts stay quiet on this page only while this pane (which lists them) is open.
      onResize={(size) => {
        const collapsed = size.inPixels < 1;
        if (appStore.getState().ui.liveAssistantCollapsed !== collapsed) setUi({ liveAssistantCollapsed: collapsed });
      }}
    >
      <div dir={dir} className="h-full bg-surface/40">
        <AssistantPanel />
      </div>
    </Panel>
  );
  const sep = (key: string) => <Separator key={key} className="app-separator" />;

  // react-resizable-panels has no RTL mode: keep the group LTR and mirror the order instead.
  const children = isRTL
    ? [assistant, sep('s1'), viewer, sep('s2'), device]
    : [device, sep('s1'), viewer, sep('s2'), assistant];

  return (
    <div className="h-full">
      <Group
        orientation="horizontal"
        dir="ltr"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
        className="h-full"
      >
        {children}
      </Group>
      {manual.dialog}
    </div>
  );
}
