// 2. Live Control: real frames, honest polling numbers, manual control behind
//    a confirmation, a click on the viewer becomes a tap at the right point.
// 3. With manual control off, touches are disabled and refused.
// 11. Paused / not running iPhone Mirroring states.
// Plus: taps still map correctly after the Mirroring window changes size.

import { expect, test } from '@playwright/test';

import {
  apiFetch,
  callsSince,
  describeScreen,
  findElement,
  frameNaturalSize,
  getSettings,
  INPUT_TOOLS,
  login,
  mockStarts,
  openRoute,
  readCalls,
  resetState,
  setControl,
  viewerImage,
  viewerPointFor,
  viewerSrc,
  waitForCall,
  waitForRestartAfter,
  writeMockState,
} from './helpers';

test.beforeEach(async ({ page }) => {
  await login(page);
  await resetState(page);
  await openRoute(page, '#/live');
  await expect(page.getByRole('region', { name: 'iPhone screen' })).toBeVisible();
  await expect(viewerImage(page)).toBeVisible();
});

test('the viewer shows real frames with honest polling numbers, and a click taps the phone', async ({ page }) => {
  // Frames are the mock's real PNGs at the 2× backing scale of a 410×898 pt window.
  await expect.poll(() => frameNaturalSize(page)).toEqual({ width: 820, height: 1796 });
  await expect(page.getByText(/^Polling · \d+(\.\d)? fps · \d+ ms$/)).toBeVisible();
  await expect(page.getByText('Polling screenshots — not video.')).toBeVisible();
  await expect(page.getByText(/^2× \(820 × 1,?796 px\)$/)).toBeVisible();
  await expect(page.getByText('Touch off', { exact: true })).toBeVisible();

  // Turning manual control on asks first; nothing changes until confirmed.
  await page.getByText('Allow manual control').click();
  const dialog = page.getByRole('alertdialog', { name: 'Turn on manual control?' });
  await expect(dialog).toBeVisible();
  expect((await getSettings(page)).permissions.manualControlEnabled).toBe(false);
  const starts = mockStarts();
  await dialog.getByRole('button', { name: 'Turn on' }).click();
  await expect(dialog).toBeHidden();
  await waitForRestartAfter(page, starts); // Mirroir reloads its permission file with input allowed
  expect((await getSettings(page)).permissions.manualControlEnabled).toBe(true);
  await expect(page.getByText('Touch on', { exact: true })).toBeVisible();
  const surface = page.getByRole('application', { name: 'iPhone screen — click to tap, drag to swipe' });
  await expect(surface).toBeVisible();

  // Where the mock Home Screen's "Settings" icon is, in window points.
  const home = await describeScreen(page);
  const settingsIcon = findElement(home, 'Settings');
  expect(home.geometry?.widthPt).toBe(410);

  const mark = readCalls().length;
  const before = await viewerSrc(page);
  const point = await viewerPointFor(page, settingsIcon, home.geometry!.widthPt);
  await page.mouse.click(point.x, point.y);

  const tap = await waitForCall((c) => c.name === 'tap', { since: mark, message: 'no tap reached the mock' });
  expect(Math.abs(Number(tap.args.x) - settingsIcon.x)).toBeLessThanOrEqual(4);
  expect(Math.abs(Number(tap.args.y) - settingsIcon.y)).toBeLessThanOrEqual(4);
  // Exactly one input call for one click.
  expect(callsSince(mark).filter((c) => INPUT_TOOLS.has(c.name))).toHaveLength(1);

  // The next frame shows the Settings screen.
  await expect.poll(() => viewerSrc(page), { message: 'a new frame after the tap' }).not.toBe(before);
  await expect.poll(async () => (await describeScreen(page)).rawText, { message: 'Settings opened' }).toContain('"Wi-Fi"');
});

test('touches are disabled and refused while manual control is off', async ({ page }) => {
  expect((await getSettings(page)).permissions.manualControlEnabled).toBe(false);
  await expect(page.getByText('Touch off', { exact: true })).toBeVisible();
  await expect(page.getByRole('application', { name: /click to tap/ })).toHaveCount(0);
  await expect(page.getByText('Turn on to tap, swipe and type on your iPhone from here.')).toBeVisible();
  await expect(page.locator('button', { hasText: /^Home$/ })).toBeDisabled();

  const home = await describeScreen(page);
  const settingsIcon = findElement(home, 'Settings');
  const mark = readCalls().length;
  const point = await viewerPointFor(page, settingsIcon, home.geometry!.widthPt);
  await page.mouse.click(point.x, point.y);
  await page.mouse.down({ button: 'left' });
  await page.mouse.move(point.x, point.y - 200, { steps: 5 });
  await page.mouse.up({ button: 'left' });

  // The API refuses manual input too (policy), and Mirroir never sees it.
  const res = await apiFetch(page, 'POST', '/api/control/action', {
    action: { kind: 'tap', x: settingsIcon.x, y: settingsIcon.y },
    geometryId: home.geometry?.geometryId ?? null,
    frameSeq: null,
  });
  expect(res.status()).toBe(403);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe('policy_denied');

  await page.waitForTimeout(1500);
  expect(callsSince(mark).filter((c) => INPUT_TOOLS.has(c.name))).toEqual([]);
  expect((await describeScreen(page)).rawText).not.toContain('"Wi-Fi"');
});

test('paused and not-running iPhone Mirroring show what to do next', async ({ page }) => {
  await expect.poll(() => frameNaturalSize(page)).toEqual({ width: 820, height: 1796 });
  const viewer = page.getByRole('region', { name: 'iPhone screen' });

  writeMockState({ mirroring: 'paused' });
  await expect(viewer.getByText('iPhone Mirroring is paused', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(viewer.getByText('Unlock your iPhone, or click Resume to continue the session.')).toBeVisible();
  await expect(viewer.getByRole('button', { name: 'Resume' })).toBeVisible();
  await expect(page.getByRole('banner', { name: 'Status' }).getByRole('button', { name: 'Mirroring paused' })).toBeVisible();

  writeMockState({ mirroring: 'not_running' });
  await expect(viewer.getByText(/^iPhone Mirroring isn.t open$/)).toBeVisible({ timeout: 20_000 });
  await expect(viewer.getByText('Open Apple’s iPhone Mirroring app on this Mac to see your iPhone here.')).toBeVisible();
  // The reconnect button is there (not clicked: it would launch the real iPhone Mirroring app).
  const overlayButton = viewer.locator('.phone-screen').getByRole('button', { name: 'Open iPhone Mirroring' });
  await expect(overlayButton).toBeVisible();
  await expect(overlayButton).toBeEnabled();
  await expect(page.getByRole('banner', { name: 'Status' }).getByRole('button', { name: 'Mirroring not running' })).toBeVisible();
});

test('after the Mirroring window changes size, a click still taps the right element', async ({ page }) => {
  await setControl(page, { manual: true });
  await expect(page.getByText('Touch on', { exact: true })).toBeVisible();
  await expect.poll(() => frameNaturalSize(page)).toEqual({ width: 820, height: 1796 });

  // A bigger window (e.g. another iPhone model): frames, geometry and coordinates all change.
  writeMockState({ window: '430x932' });
  await expect.poll(() => frameNaturalSize(page), { timeout: 20_000 }).toEqual({ width: 860, height: 1864 });
  await expect(page.getByText('430 × 932 pt')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Touch on', { exact: true })).toBeVisible();

  const home = await describeScreen(page);
  expect(home.geometry?.geometryId).toBe('430x932');
  const settingsIcon = findElement(home, 'Settings');
  const mark = readCalls().length;
  const point = await viewerPointFor(page, settingsIcon, home.geometry!.widthPt);
  await page.mouse.click(point.x, point.y);

  const tap = await waitForCall((c) => c.name === 'tap', { since: mark, message: 'no tap reached the mock' });
  expect(Math.abs(Number(tap.args.x) - settingsIcon.x)).toBeLessThanOrEqual(4);
  expect(Math.abs(Number(tap.args.y) - settingsIcon.y)).toBeLessThanOrEqual(4);
  await expect.poll(async () => (await describeScreen(page)).rawText, { message: 'Settings opened' }).toContain('"Wi-Fi"');
});
