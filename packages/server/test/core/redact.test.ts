// Redaction for logs, activity history and diagnostics.

import { describe, expect, it } from 'vitest';

import { describeTypedText, redactSecrets, redactToolArgs, redactUrl, redactValue } from '../../src/core/redact.js';

describe('redactSecrets', () => {
  it('masks API keys, bearer tokens and long hex secrets inside free text', () => {
    expect(redactSecrets('key=sk-ant-api03-abcdefghijklmnopqrstuvwxyz rest')).toBe('key=[redacted] rest');
    expect(redactSecrets('openai sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX done')).toBe('openai [redacted] done');
    expect(redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload')).toBe('Authorization: [redacted]');
    expect(redactSecrets(`token ${'a1'.repeat(20)}`)).toBe('token [redacted]');
  });

  it('leaves normal text alone', () => {
    expect(redactSecrets('Tapped at (205, 440)')).toBe('Tapped at (205, 440)');
    expect(redactSecrets('sk-short')).toBe('sk-short');
    expect(redactSecrets('abc123')).toBe('abc123');
  });
});

describe('describeTypedText', () => {
  it('counts characters (code points), not UTF-16 units', () => {
    expect(describeTypedText('hello')).toBe('«5 characters»');
    expect(describeTypedText('مرحبا')).toBe('«5 characters»');
    expect(describeTypedText('😀a')).toBe('«2 characters»');
  });
});

describe('redactToolArgs', () => {
  it('replaces typed text with its length by default', () => {
    expect(redactToolArgs('type_text', { text: 'my secret note' })).toEqual({ text: '«14 characters»' });
    // Any "text" argument is treated as typed text.
    expect(redactToolArgs('custom', { text: 'abc', label: 'Send' })).toEqual({ text: '«3 characters»', label: 'Send' });
  });

  it('keeps typed text when the user opted in, still masking secrets', () => {
    expect(redactToolArgs('type_text', { text: 'hello' }, { keepTypedText: true })).toEqual({ text: 'hello' });
    expect(redactToolArgs('type_text', { text: 'use sk-ant-abcdefghijklmnop' }, { keepTypedText: true })).toEqual({
      text: 'use [redacted]',
    });
  });

  it('masks secret-looking keys and strips URL queries', () => {
    expect(
      redactToolArgs('x', {
        apiKey: 'abc',
        password: 'p',
        Authorization: 'Bearer x',
        otp: '123456',
        url: 'https://user:pw@example.com/reset?token=abc#frag',
        x: 10,
      }),
    ).toEqual({
      apiKey: '[redacted]',
      password: '[redacted]',
      Authorization: '[redacted]',
      otp: '[redacted]',
      url: 'https://example.com/reset?[redacted]',
      x: 10,
    });
  });

  it('returns an empty object for missing args', () => {
    expect(redactToolArgs('tap', undefined)).toEqual({});
  });
});

describe('redactUrl', () => {
  it('drops query, fragment and credentials', () => {
    expect(redactUrl('https://example.com/path')).toBe('https://example.com/path');
    expect(redactUrl('https://a:b@example.com/p?q=1')).toBe('https://example.com/p?[redacted]');
    expect(redactUrl('https://example.com/#access_token=abc')).toBe('https://example.com/?[redacted]');
  });

  it('falls back to secret redaction for unparsable input', () => {
    expect(redactUrl('not a url sk-ant-abcdefghijklmnop')).toBe('not a url [redacted]');
  });
});

describe('redactValue', () => {
  it('recurses into objects and arrays, masking secret keys', () => {
    expect(redactValue({ nested: { refresh_token: 'x', list: [{ secret: 'y', ok: 1 }] }, note: 'Bearer abcdefghijklmnop' })).toEqual({
      nested: { refresh_token: '[redacted]', list: [{ secret: '[redacted]', ok: 1 }] },
      note: '[redacted]',
    });
  });

  it('drops base64 blobs and truncates very long strings', () => {
    const blob = 'iVBORw0KGgo'.repeat(400);
    expect(redactValue(blob)).toBe(`[binary ${blob.length} chars]`);
    const long = 'Hello, world! '.repeat(400);
    const out = redactValue(long) as string;
    expect(out.length).toBe(4001);
    expect(out.endsWith('…')).toBe(true);
  });

  it('limits depth and array length', () => {
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 10; i += 1) deep = { d: deep };
    expect(JSON.stringify(redactValue(deep))).toContain('[truncated]');
    expect((redactValue(Array.from({ length: 150 }, (_, i) => i)) as unknown[]).length).toBe(100);
  });

  it('passes primitives through', () => {
    expect(redactValue(42)).toBe(42);
    expect(redactValue(null)).toBeNull();
    expect(redactValue(true)).toBe(true);
  });
});
