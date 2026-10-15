// How iPhone tool results reach the Claude Code engine (Agent SDK MCP tools).
// The Claude API accepts only text in an error tool_result, so an error that
// carries a screenshot must not be flagged isError. Pure function; no engine.

import { describe, expect, it } from 'vitest';

import { toCallToolResult } from '../../src/ai/providers/claude-agent-sdk.js';

const shot = { type: 'image' as const, mimeType: 'image/png', data: 'iVBORw0KGgo=' };

describe('toCallToolResult', () => {
  it('passes normal results and text-only errors through', () => {
    expect(toCallToolResult({ isError: false, content: [{ type: 'text', text: 'Tapped.' }, shot] })).toEqual({
      isError: false,
      content: [{ type: 'text', text: 'Tapped.' }, { type: 'image', data: shot.data, mimeType: 'image/png' }],
    });
    expect(toCallToolResult({ isError: true, content: [{ type: 'text', text: 'Unknown element' }] })).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'Unknown element' }],
    });
  });

  it('sends an error with a screenshot as a normal result whose text starts with ERROR:', () => {
    expect(toCallToolResult({ isError: true, content: [{ type: 'text', text: "'برجر' not found" }, shot] })).toEqual({
      isError: false,
      content: [{ type: 'text', text: "ERROR: 'برجر' not found" }, { type: 'image', data: shot.data, mimeType: 'image/png' }],
    });
    expect(toCallToolResult({ isError: true, content: [shot] })).toEqual({
      isError: false,
      content: [{ type: 'text', text: 'ERROR' }, { type: 'image', data: shot.data, mimeType: 'image/png' }],
    });
  });
});
