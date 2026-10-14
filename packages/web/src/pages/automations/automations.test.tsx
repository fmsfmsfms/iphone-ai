import type { WorkflowStep } from '@iphone-ai/shared';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import './messages';
import { makeBootstrap, makeRun } from '../../test/fixtures';
import { appStore, reduceBootstrap, resetStoreForTests } from '../../state/store';
import { RunView } from './RunView';
import { WorkflowEditor } from './WorkflowEditor';
import { validateDraft, type WorkflowDraft } from './workflow-utils';

beforeEach(() => {
  resetStoreForTests();
  act(() => appStore.setState((s) => reduceBootstrap(s, makeBootstrap())));
});

afterEach(() => {
  resetStoreForTests();
});

const steps: WorkflowStep[] = [
  { id: 'a', type: 'launch_app', app: 'Settings' },
  { id: 'b', type: 'tap_point', x: 100, y: 200, geometryId: '300x600' },
  { id: 'c', type: 'type_text', text: 'secret', sensitive: true },
];

function Harness({ initial, onDraft }: { initial: WorkflowDraft; onDraft?: (d: WorkflowDraft) => void }) {
  const [draft, setDraft] = useState(initial);
  return (
    <WorkflowEditor
      draft={draft}
      onChange={(next) => {
        setDraft(next);
        onDraft?.(next);
      }}
      validation={validateDraft(draft)}
      showAllErrors={false}
    />
  );
}

describe('WorkflowEditor', () => {
  it('lists steps with summaries and reorders them', async () => {
    let latest: WorkflowDraft | null = null;
    render(<Harness initial={{ name: 'Test', description: '', source: 'manual', steps }} onDraft={(d) => (latest = d)} />);
    expect(screen.getByText('Open “Settings”')).toBeInTheDocument();
    expect(screen.getByText('Type 6 hidden characters')).toBeInTheDocument();
    expect(screen.queryByText('secret')).not.toBeInTheDocument();

    const moveDown = screen.getAllByRole('button', { name: 'Move down' });
    await userEvent.click(moveDown[0]!);
    expect(latest!.steps.map((s) => s.id)).toEqual(['b', 'a', 'c']);
  });

  it('warns that recorded coordinates only fit one window size', async () => {
    render(<Harness initial={{ name: 'Test', description: '', source: 'recorded', steps }} />);
    await userEvent.click(screen.getByText('Tap at (100, 200)'));
    expect(screen.getByText('Recorded coordinates')).toBeInTheDocument();
    expect(screen.getByText('Only valid for window size 300×600.')).toBeInTheDocument();
    // The live window (410x890 in the fixtures) differs, so the step will fail.
    expect(screen.getByText('The iPhone Mirroring window is now 410×890, so this step will fail.')).toBeInTheDocument();
  });
});

describe('RunView', () => {
  it('shows per-step results, outputs and errors', () => {
    const workflow = {
      id: 'wf_1',
      name: 'Morning check',
      description: '',
      steps: [
        { id: 'a', type: 'launch_app', app: 'Settings' },
        { id: 'r', type: 'read_screen', saveAs: 'battery' },
        { id: 'w', type: 'wait_for_text', label: 'Battery Health' },
      ] as WorkflowStep[],
      createdAt: 1,
      updatedAt: 1,
      lastRunAt: 1,
      lastRunStatus: 'failed' as const,
      lastSuccessAt: null,
      source: 'manual' as const,
    };
    const run = makeRun({
      status: 'failed',
      endedAt: 9_000,
      error: 'Timed out waiting for “Battery Health”.',
      steps: [
        { stepId: 'a', status: 'succeeded', startedAt: 1_000, endedAt: 2_000, message: 'Opened Settings', output: null, screenshotId: null },
        { stepId: 'r', status: 'succeeded', startedAt: 2_000, endedAt: 3_000, message: null, output: '87%', screenshotId: null },
        { stepId: 'w', status: 'failed', startedAt: 3_000, endedAt: 9_000, message: 'Text not found', output: null, screenshotId: null },
      ],
    });
    render(<RunView run={run} workflow={workflow} />);
    expect(screen.getByText('Opened Settings')).toBeInTheDocument();
    expect(screen.getByText('87%')).toBeInTheDocument();
    expect(screen.getByText('Saved as {battery}')).toBeInTheDocument();
    expect(screen.getByText('Timed out waiting for “Battery Health”.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry from step 3' })).toBeInTheDocument();
  });
});
