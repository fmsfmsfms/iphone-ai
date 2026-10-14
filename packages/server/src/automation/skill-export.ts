// SKILL.md export. Mirroir has no deterministic SKILL.md runner (its `test`
// CLI only reads YAML and bypasses the permission policy), so this file is a
// derived artifact for list_skills / get_skill and other MCP clients; iPhone
// AI's own step engine stays the executor.
//
// Mirroir's front matter parser is a naive line-prefix match: every value is
// written on one line, tags as an inline list, and no block scalars.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Workflow, WorkflowStep } from '@iphone-ai/shared';

/** Filesystem-safe slug for the exported file name. */
export function skillSlug(name: string, fallback: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || fallback.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
}

/** One line, no characters that confuse Mirroir's line-based front matter parser. */
function frontMatterValue(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[>|]+\s*/, '')
    .replace(/^---/, '—');
}

function inlineText(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/"/g, '\\"').trim();
}

function envName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/** ${VAR} names for sensitive type_text steps, derived from the field tapped just before (else the step id). */
function sensitiveVariables(steps: readonly WorkflowStep[]): Map<string, string> {
  const names = new Map<string, string>();
  const used = new Set<string>();
  steps.forEach((step, index) => {
    if (step.type !== 'type_text' || !step.sensitive) return;
    const previous = index > 0 ? steps[index - 1] : undefined;
    let base = previous && (previous.type === 'tap_text' || previous.type === 'long_press_text') ? envName(previous.label) : '';
    if (!base || /^\d/.test(base)) base = `SECRET_${envName(step.id) || index + 1}`;
    let name = base;
    for (let n = 2; used.has(name); n += 1) name = `${base}_${n}`;
    used.add(name);
    names.set(step.id, name);
  });
  return names;
}

function seconds(ms: number): string {
  const s = ms / 1000;
  return Number.isInteger(s) ? `${s}` : s.toFixed(1).replace(/\.0$/, '');
}

function stepLine(step: WorkflowStep, vars: ReadonlyMap<string, string>): string {
  switch (step.type) {
    case 'launch_app':
      return `Launch **${inlineText(step.app)}**`;
    case 'tap_text':
      return `Tap "${inlineText(step.label)}"`;
    case 'long_press_text':
      return `Long press "${inlineText(step.label)}"`;
    case 'tap_point':
      return `Tap at (${Math.round(step.x)}, ${Math.round(step.y)})${step.geometryId ? ` (window ${step.geometryId} pt)` : ''}${step.note ? ` — ${inlineText(step.note)}` : ''}`;
    case 'swipe':
      return `Swipe ${step.direction}`;
    case 'type_text': {
      const variable = vars.get(step.id);
      return variable ? `Type "\${${variable}}"` : `Type "${inlineText(step.text)}"`;
    }
    case 'press_key':
      return `Press **${inlineText(step.key)}**`;
    case 'press_home':
      return 'Press Home';
    case 'press_back':
      return 'Go back';
    case 'open_url':
      return `Open URL: ${inlineText(step.url)}`;
    case 'scroll_to':
      return `Scroll to "${inlineText(step.label)}"`;
    case 'wait_for_text':
      return `Wait for "${inlineText(step.label)}" to appear`;
    case 'assert_text':
      return `Verify "${inlineText(step.label)}" ${step.present ? 'is visible' : 'is not visible'}`;
    case 'screenshot':
      return `Screenshot: "${inlineText(step.label)}"`;
    case 'read_screen':
      return `Remember: ${step.instruction?.trim() ? inlineText(step.instruction) : 'the text visible on screen'} as {${step.saveAs}}`;
    case 'ai_task':
      return `AI: ${inlineText(step.instruction)}`;
    case 'checkpoint':
      return `Checkpoint: ${inlineText(step.message)} (ask the user to confirm before continuing)`;
    case 'wait':
      return `Wait ${seconds(step.ms)} seconds`;
  }
}

/** Renders a workflow as a Mirroir SKILL.md document. */
export function renderSkillMarkdown(workflow: Workflow): string {
  const app = workflow.steps.find((s): s is Extract<WorkflowStep, { type: 'launch_app' }> => s.type === 'launch_app')?.app;
  const description = frontMatterValue(workflow.description) || `Workflow exported from iPhone AI: ${frontMatterValue(workflow.name)}`;
  const vars = sensitiveVariables(workflow.steps);
  const lines: string[] = ['---', 'version: 1', `name: ${frontMatterValue(workflow.name)}`];
  if (app) lines.push(`app: ${frontMatterValue(app)}`);
  lines.push(`description: ${description}`, 'tags: [iphone-ai]', '---', '', description, '');
  lines.push('> Note: Exported from iPhone AI. iPhone AI runs this workflow with its own step engine; this file is for reference and AI agents.');
  if (vars.size > 0) {
    lines.push(`> Note: Secret values are not exported. Provide ${[...vars.values()].map((v) => `\${${v}}`).join(', ')} from the environment, or type them yourself.`);
  }
  lines.push('', '## Steps', '');
  workflow.steps.forEach((step, index) => {
    lines.push(`${index + 1}. ${stepLine(step, vars)}`);
  });
  lines.push('');
  return lines.join('\n');
}

/** Writes <skillsDir>/<slug>.md and returns its path and content. */
export function writeSkillFile(skillsDir: string, workflow: Workflow): { path: string; markdown: string } {
  const markdown = renderSkillMarkdown(workflow);
  mkdirSync(skillsDir, { recursive: true, mode: 0o700 });
  const file = path.join(skillsDir, `${skillSlug(workflow.name, workflow.id)}.md`);
  writeFileSync(file, markdown, { mode: 0o600 });
  return { path: file, markdown };
}
