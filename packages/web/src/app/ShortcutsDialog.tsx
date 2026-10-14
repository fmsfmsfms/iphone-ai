// "Keyboard shortcuts" reference (opened with ? or from the sidebar).

import { Keyboard } from '@gravity-ui/icons';
import { Button, Modal } from '@heroui/react';

import { KbdHint, type ShortcutKey } from '../components/KbdHint';
import { useI18n } from '../lib/i18n';

interface ShortcutRow {
  keys: ShortcutKey[][];
  labelKey: string;
}

const GROUPS: { titleKey: string; rows: ShortcutRow[] }[] = [
  {
    titleKey: 'shortcuts.group.global',
    rows: [
      { keys: [['mod', '1'], ['mod', '6']], labelKey: 'shortcuts.sections' },
      { keys: [['mod', '.']], labelKey: 'shortcuts.stop' },
      { keys: [['escape'], ['escape']], labelKey: 'shortcuts.stopEsc' },
      { keys: [['?']], labelKey: 'shortcuts.help' },
    ],
  },
  {
    titleKey: 'shortcuts.group.live',
    rows: [
      { keys: [['R']], labelKey: 'shortcuts.refresh' },
      { keys: [['M']], labelKey: 'shortcuts.manual' },
      { keys: [['T']], labelKey: 'shortcuts.type' },
    ],
  },
  {
    titleKey: 'shortcuts.group.chat',
    rows: [{ keys: [['mod', 'enter']], labelKey: 'shortcuts.send' }],
  },
];

export function ShortcutsDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange} variant="blur">
      <Modal.Container size="sm" placement="center">
        <Modal.Dialog className="app-panel bg-overlay">
          <Modal.CloseTrigger />
          <Modal.Header className="flex flex-row items-center gap-3">
            <Modal.Icon className="bg-default text-foreground">
              <Keyboard className="size-5" />
            </Modal.Icon>
            <Modal.Heading className="text-base font-semibold">{t('shortcuts.title')}</Modal.Heading>
          </Modal.Header>
          <Modal.Body className="space-y-5">
            {GROUPS.map((group) => (
              <section key={group.titleKey}>
                <h3 className="mb-2 text-[11px] font-semibold tracking-wide text-muted uppercase">{t(group.titleKey)}</h3>
                <ul className="divide-y divide-hairline rounded-xl border border-hairline">
                  {group.rows.map((row) => (
                    <li key={row.labelKey} className="flex items-center justify-between gap-4 px-3 py-2 text-[13px]">
                      <span className="text-foreground">{t(row.labelKey)}</span>
                      <span className="flex shrink-0 items-center gap-1 text-xs text-muted">
                        {row.keys.map((combo, i) => (
                          <span key={i} className="flex items-center gap-1">
                            {i > 0 ? <span>{row.labelKey === 'shortcuts.sections' ? '–' : ''}</span> : null}
                            <KbdHint keys={combo} />
                          </span>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </Modal.Body>
          <Modal.Footer className="flex justify-end">
            <Button variant="secondary" slot="close">
              {t('common.close')}
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
