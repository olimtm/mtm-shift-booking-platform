import { chromium, expect, type Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';

// An isolated, fictional workspace; never read .env or connect to Airtable.
for (const key of Object.keys(process.env))
  if (key.startsWith('AIRTABLE_')) delete process.env[key];
const { createApp } = await import('../server/app.ts');
const origin = 'http://127.0.0.1:3040';
const runtime = createApp({
  databasePath: ':memory:',
  demoMode: true,
  enableSync: false,
  publicOrigin: origin,
});
runtime.app.use(express.static(resolve('dist')));
const server = runtime.app.listen(3040, '127.0.0.1');
await new Promise<void>((resolve, reject) => {
  server.once('listening', resolve);
  server.once('error', reject);
});
const browser = await chromium.launch({
  executablePath: existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined,
  args: ['--no-sandbox'],
});
const artifacts = '/tmp/mtm-appearance';
mkdirSync(artifacts, { recursive: true });
const failures: string[] = [];
let screens = 0;
let textSamples = 0;
async function audit(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  const result = await page.evaluate(() => {
    const issues: string[] = [];
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    const cache = new Map<string, number[]>();
    function rgba(value: string): number[] {
      if (cache.has(value)) return cache.get(value)!;
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const result = [...context.getImageData(0, 0, 1, 1).data];
      cache.set(value, result);
      return result;
    }
    function blend(front: number[], back: number[]) {
      const alpha = front[3] / 255;
      return [...front.slice(0, 3).map((v, i) => v * alpha + back[i] * (1 - alpha)), 255];
    }
    function luminance(rgb: number[]) {
      const linear = rgb.slice(0, 3).map((n) => {
        const v = n / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    }
    const colours = ['#73cbe9', '#f877b0', '#0e2647', '#ffffff', '#000000'].map(rgba);
    // Brand colours may be softened with white. Test the actual rendered colour
    // against that palette, then check contrast on the resulting surface.
    function matches(value: number[]) {
      return colours.some((rgb) => {
        const channel = rgb.slice(0, 3).indexOf(Math.min(...rgb.slice(0, 3)));
        if (rgb[channel] === 255) return value.slice(0, 3).every((v) => v >= 254);
        const tint = (255 - value[channel]) / (255 - rgb[channel]);
        return (
          tint >= 0 &&
          tint <= 1 &&
          value.slice(0, 3).every((v, i) => Math.abs(v - (rgb[i] * tint + 255 * (1 - tint))) <= 2)
        );
      });
    }
    let textCount = 0;
    const modal = document.querySelector('[role="dialog"]');
    const drawer = document.querySelector('.sidebar.mobile-open');
    const scope = modal || drawer || document.body;
    for (const el of scope.querySelectorAll<HTMLElement>('*')) {
      if (
        !(el instanceof HTMLElement) ||
        !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      )
        continue;
      if (el.closest('option,script,style,[hidden]')) continue;
      const s = getComputedStyle(el);
      if (s.opacity === '0' || el.closest(':disabled')) continue;
      const bg = rgba(s.backgroundColor);
      if (bg[3] === 255 && !matches(bg))
        issues.push(`Off-palette background ${s.backgroundColor}: ${el.className}`);
      if (
        colours.slice(0, 2).some((rgb) => bg.every((v, i) => Math.abs(v - rgb[i]) <= 1)) &&
        el.getBoundingClientRect().width * el.getBoundingClientRect().height > 4096
      )
        issues.push(`Large solid accent fill: ${el.className}`);
      const text =
        [...el.childNodes]
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent)
          .join('')
          .trim() ||
        (el.matches('input,select,textarea')
          ? (el as HTMLInputElement).value || 'Form control'
          : '');
      if (!text) continue;
      textCount++;
      const description = `${el.tagName}.${el.className} (${text.slice(0, 45)})`;
      if (parseFloat(s.fontSize) < 13)
        issues.push(`Text below 13px: ${description}: ${s.fontSize}`);
      if (
        innerWidth <= 600 &&
        el.matches('input:not([type=checkbox]),select,textarea') &&
        parseFloat(s.fontSize) < 16
      )
        issues.push(`Mobile form control below 16px: ${description}: ${s.fontSize}`);
      if (parseFloat(s.fontWeight) < 400)
        issues.push(`Light text: ${description}: ${s.fontWeight}`);
      const fg = rgba(s.color);
      if (!matches(fg)) issues.push(`Off-palette text: ${description}: ${s.color}`);
      const ancestors: HTMLElement[] = [];
      for (let node: HTMLElement | null = el; node; node = node.parentElement)
        ancestors.unshift(node);
      let background = [255, 255, 255, 255];
      for (const node of ancestors)
        background = blend(rgba(getComputedStyle(node).backgroundColor), background);
      const foreground = blend(fg, background);
      const light = luminance(foreground),
        dark = luminance(background);
      const contrast = (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
      if (contrast < 4.5)
        issues.push(`Contrast ${contrast.toFixed(2)}: ${description} (${s.color})`);
    }
    if (document.documentElement.scrollWidth > innerWidth + 1)
      issues.push(`Page overflow: ${document.documentElement.scrollWidth} > ${innerWidth}`);
    for (const card of scope.querySelectorAll('.calendar-shift')) {
      if (card.getBoundingClientRect().width < 160)
        issues.push('Overlapping calendar bookings have less than 160px to display their text');
    }
    return { issues: [...new Set(issues)], textCount };
  });
  textSamples += result.textCount;
  screens++;
  failures.push(...result.issues.map((issue) => `${name}: ${issue}`));
  await page.screenshot({
    path: `${artifacts}/${name}.png`,
    fullPage: true,
    animations: 'disabled',
  });
}
async function nav(page: Page, name: string) {
  const open = page.getByRole('button', { name: 'Open navigation' });
  if (await open.isVisible()) await open.click();
  await page
    .locator('.sidebar')
    .getByRole('button', { name: new RegExp(`^${name}`) })
    .click();
}
try {
  const page = await browser.newPage();
  // tsx preserves local function names with this helper when serializing
  // evaluate callbacks; provide the identity helper in the browser context.
  await page.addInitScript('window.__name = (fn) => fn;');
  page.on('pageerror', (e) => failures.push(e.message));
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(origin);
    if (await page.getByRole('button', { name: 'Log out' }).count()) {
      await page.context().clearCookies();
      await page.reload();
    }
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    await audit(page, `login-${width}`);
    await page.getByRole('button', { name: 'Staff workspace', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Support schedule', exact: true }),
    ).toBeVisible();
    for (const [name, file] of [
      ['Support schedule', 'schedule'],
      ['Requests', 'requests'],
      ['Participants', 'participants'],
      ['People & access', 'accounts'],
      ['Support workers', 'workers'],
      ['Event support', 'events'],
      ['Airtable', 'airtable'],
    ]) {
      await nav(page, name);
      await audit(page, `${file}-${width}`);
    }
    await nav(page, 'Requests');
    await page.getByRole('button', { name: 'New shift request', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await audit(page, `request-form-${width}`);
    await page.getByRole('button', { name: 'Close dialog' }).click();
    await page.locator('.shift-list-row').first().click();
    await audit(page, `request-detail-${width}`);
    await page.getByRole('button', { name: 'Close dialog' }).click();
    if (width <= 1024) {
      await page.getByRole('button', { name: 'Open navigation' }).click();
      await audit(page, `navigation-${width}`);
      await page.getByRole('button', { name: 'Close navigation' }).last().click();
    }
    await page.context().clearCookies();
    await page.goto(origin);
    await page.getByRole('button', { name: 'Client portal', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'My support', exact: true })).toBeVisible();
    await audit(page, `client-${width}`);
    await page.context().clearCookies();
    await page.goto(origin + '/#invite=invalid-test-link');
    await expect(page.getByRole('alert')).toBeVisible();
    await audit(page, `access-error-${width}`);
    await page.context().clearCookies();
  }
  writeFileSync(
    `${artifacts}/report.json`,
    JSON.stringify({ screens, textSamples, failures }, null, 2),
  );
  assert.deepEqual(failures, []);
  console.log(
    `Appearance passed: ${screens} screens, ${textSamples} text samples; MTM tints, no large solid accent fills, 13px minimum labels, 16px mobile inputs, contrast >=4.5:1, no page overflow.`,
  );
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  runtime.close();
}
