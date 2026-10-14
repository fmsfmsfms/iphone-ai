// 10. Settings → General: switching to Arabic mirrors the whole UI (RTL) and
// translates the navigation; switching back restores English / LTR.

import { expect, test } from '@playwright/test';

import { api, getSettings, login, openRoute, resetState } from './helpers';

test.beforeEach(async ({ page }) => {
  await login(page);
  await resetState(page);
});

test.afterEach(async ({ page }) => {
  if ((await getSettings(page)).general.language !== 'en') await api(page, 'PUT', '/api/settings', { general: { language: 'en' } });
});

test('switching the language to Arabic turns the UI right-to-left', async ({ page }) => {
  await openRoute(page, '#/settings/general');
  const html = page.locator('html');
  await expect(html).toHaveAttribute('dir', 'ltr');
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Dashboard' })).toBeVisible();

  const english = page.getByRole('radio', { name: 'English', exact: true });
  const arabic = page.getByRole('radio', { name: 'العربية', exact: true });
  await expect(page.getByRole('radiogroup', { name: 'Language' })).toBeVisible();
  await expect(english).toHaveAttribute('aria-checked', 'true');
  await arabic.click();

  await expect(html).toHaveAttribute('dir', 'rtl');
  await expect(html).toHaveAttribute('lang', 'ar');
  const nav = page.getByRole('navigation', { name: 'التنقل الرئيسي' });
  await expect(nav).toBeVisible();
  for (const label of ['لوحة التحكم', 'التحكم المباشر', 'المساعد الذكي', 'الأتمتة', 'سجل النشاط', 'الإعدادات']) {
    await expect(nav.getByRole('button', { name: label })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'إيقاف تحكم الذكاء الاصطناعي' })).toBeVisible();
  // The sidebar sits on the right in RTL.
  const box = await nav.boundingBox();
  const viewport = page.viewportSize();
  expect(box && viewport ? box.x + box.width : 0).toBeGreaterThan((viewport?.width ?? 0) - 5);
  expect((await getSettings(page)).general.language).toBe('ar');

  // Back to English.
  await expect(arabic).toHaveAttribute('aria-checked', 'true');
  await english.click();
  await expect(html).toHaveAttribute('dir', 'ltr');
  await expect(html).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Dashboard' })).toBeVisible();
  expect((await getSettings(page)).general.language).toBe('en');
});
