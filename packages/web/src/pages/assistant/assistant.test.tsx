import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import './messages';
import type { ControlMode } from '@iphone-ai/shared';
import { setLanguage, type Language } from '../../lib/i18n';
import { makeBootstrap, makeMessage, makeSettings, makeStep, makeTask } from '../../test/fixtures';
import { TaskCard } from '../../components/chat';
import { appStore, reduceBootstrap, replaceMessages, resetStoreForTests, setConnection, setTaskSteps, upsertTask } from '../../state/store';
import { ConversationView } from './ConversationView';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const withKey = (acknowledged: boolean) =>
  makeSettings((s) => {
    s.ai.providers = s.ai.providers.map((p) => (p.id === 'claude-api' ? { ...p, hasApiKey: true } : p));
    s.privacy.cloudDisclosureAcknowledged = acknowledged;
  });

beforeEach(() => {
  resetStoreForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetStoreForTests();
});

describe('TaskCard', () => {
  it('explains a failure and retries the same instruction', async () => {
    act(() => {
      appStore.setState((s) => reduceBootstrap(s, makeBootstrap({ settings: withKey(true) })));
      upsertTask(makeTask({ status: 'failed', instruction: 'Open Settings', error: 'Claude rate limit reached. Try again shortly.', endedAt: 5 }));
    });
    const onRetry = vi.fn().mockResolvedValue(undefined);
    render(<TaskCard taskId="task_1" onRetry={onRetry} />);
    expect(screen.getByText('The AI provider is busy')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledWith('Open Settings');
  });

  it('shows the verification result and, on request, the steps of a completed task', async () => {
    act(() => {
      upsertTask(makeTask({ status: 'completed', endedAt: 5, outcome: { success: true, verified: true, summary: 'Settings is open' } }));
      setTaskSteps('task_1', [makeStep({ id: 'st1', title: 'Tap “Settings”' })]);
    });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, { task: appStore.getState().tasks['task_1'], steps: [] })));
    render(<TaskCard taskId="task_1" />);
    expect(screen.getByText('Verified on screen')).toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.queryByText('Tap “Settings”')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show 1 step' }));
    expect(await screen.findByText('Tap “Settings”')).toBeInTheDocument();
  });
});

describe('ConversationView', () => {
  it('blocks the first send behind the cloud disclosure until it is acknowledged', async () => {
    const acknowledged = withKey(true);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, acknowledged));
    vi.stubGlobal('fetch', fetchMock);
    act(() => {
      appStore.setState((s) => reduceBootstrap(s, makeBootstrap({ settings: withKey(false) })));
      setConnection({ socket: 'open' });
    });
    render(<ConversationView conversation={null} onCreated={vi.fn()} onChanged={vi.fn()} onDelete={vi.fn()} />);

    expect(screen.getByText('Before you send: Claude (Anthropic API) runs in the cloud')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Instruction for the AI' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'I understand' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/settings');
    expect(init?.method).toBe('PUT');
    expect(init?.body).toBe(JSON.stringify({ privacy: { cloudDisclosureAcknowledged: true } }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Instruction for the AI' })).not.toBeDisabled());
  });

  it('explains why sending is unavailable when Mirroring is paused', () => {
    act(() => {
      const boot = makeBootstrap({ settings: withKey(true) });
      boot.status.mirroring.state = 'paused';
      appStore.setState((s) => reduceBootstrap(s, boot));
      setConnection({ socket: 'open' });
    });
    render(<ConversationView conversation={null} onCreated={vi.fn()} onChanged={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByRole('textbox', { name: 'Instruction for the AI' })).toBeDisabled();
    expect(screen.getAllByText('iPhone Mirroring is paused. Lock your iPhone and keep it nearby, then click Resume in Live Control.').length).toBeGreaterThan(0);
    expect(screen.getByText(/can look and describe, but not tap/)).toBeInTheDocument();
  });

  it('shows a conversation as one thread: tasks inline, the summary once', () => {
    const summary = 'Wallet is blocked by your safety settings.';
    act(() => {
      appStore.setState((s) => reduceBootstrap(s, makeBootstrap({ settings: withKey(true) })));
      setConnection({ socket: 'open' });
      replaceMessages('conv_1', [
        makeMessage({ id: 'u1', text: 'Open Wallet.', taskId: 'task_1', createdAt: 1 }),
        makeMessage({ id: 'a1', role: 'assistant', text: summary, taskId: 'task_1', createdAt: 2 }),
      ]);
      upsertTask(makeTask({ status: 'failed', instruction: 'Open Wallet.', endedAt: 5, outcome: { success: false, verified: false, summary }, error: summary }));
    });
    const conversation = { id: 'conv_1', title: 'Open Wallet.', createdAt: 1, updatedAt: 2 };
    const { container } = render(<ConversationView conversation={conversation} onCreated={vi.fn()} onChanged={vi.fn()} onDelete={vi.fn()} />);
    const log = screen.getByRole('log', { name: 'Conversation' });
    expect(container.querySelectorAll('[role="log"]')).toHaveLength(1);
    expect(log).toContainElement(screen.getByRole('region', { name: 'AI task' }));
    expect(screen.getAllByText(summary)).toHaveLength(1);
    // The reply already says why: the coloured status is all the card adds (the advice waits with the steps).
    expect(screen.getByText('Failed', { exact: true })).toHaveClass('text-danger');
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    // A safety block is not worth retrying as is.
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });
});

// The welcome's safety line describes the active control mode: AI Mode never
// asks for approval, so it must not promise that sensitive actions do.
describe('ConversationView welcome safety line', () => {
  const SAFETY: Record<Language, Record<ControlMode, string>> = {
    en: {
      observe: 'In Observe Only the AI just looks at the screen — it never taps, swipes or types. Press STOP (⌘.) at any time.',
      assisted: 'In Assisted mode every action waits for your approval before it touches your iPhone. Press STOP (⌘.) at any time.',
      supervised:
        'In AI Mode the AI acts without asking for approval — blocked apps stay off limits, it won’t type on password or code screens, and every task has action and time limits. Press STOP (⌘.) at any time.',
    },
    ar: {
      observe: 'في وضع «مراقبة فقط» يكتفي الذكاء الاصطناعي بالنظر إلى الشاشة — لا ينقر ولا يسحب ولا يكتب. اضغط «إيقاف» (⌘.) في أي وقت.',
      assisted: 'في الوضع المساعَد ينتظر كل إجراء موافقتك قبل أن يلمس جهاز iPhone. اضغط «إيقاف» (⌘.) في أي وقت.',
      supervised:
        'في وضع الذكاء الاصطناعي ينفّذ الذكاء الاصطناعي الإجراءات دون أن يطلب موافقتك — تبقى التطبيقات المحظورة خارج النطاق، ولا يكتب في شاشات كلمات المرور والرموز، ولكل مهمة حدود لعدد الإجراءات والوقت. اضغط «إيقاف» (⌘.) في أي وقت.',
    },
  };
  const cases = (['en', 'ar'] as const).flatMap((language) =>
    (['observe', 'assisted', 'supervised'] as const).map((mode) => [language, mode] as const),
  );

  afterEach(() => setLanguage('en'));

  it.each(cases)('%s, %s mode', (language, mode) => {
    setLanguage(language);
    act(() => {
      appStore.setState((s) => reduceBootstrap(s, makeBootstrap({ settings: makeSettings((x) => {
        x.permissions.controlMode = mode;
      }) })));
      setConnection({ socket: 'open' });
    });
    render(<ConversationView conversation={null} onCreated={vi.fn()} onChanged={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText(SAFETY[language][mode])).toBeInTheDocument();
    expect(screen.queryByText(/always ask for your approval|تطلب موافقتك دائمًا/)).not.toBeInTheDocument();
  });
});
