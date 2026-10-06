import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import { newShift } from '../server/domain.ts';
import type { SupportEvent } from '../shared/types.ts';
for (const key of Object.keys(process.env))
  if (key.startsWith('AIRTABLE_')) delete process.env[key];
const { createApp } = await import('../server/app.ts');
const origin = 'http://127.0.0.1:3038';
const runtime = createApp({
  databasePath: ':memory:',
  demoMode: true,
  enableSync: false,
  publicOrigin: origin,
});
const now = Math.floor(Date.now() / 60000) * 60000;
const event = (id: string, title: string, offset: number): SupportEvent => ({
  id,
  title,
  start: new Date(now + offset).toISOString(),
  end: new Date(now + offset + 3600000).toISOString(),
  location: 'Test venue',
  description: '',
  rsvpCount: 0,
  supportCount: 0,
});
const future = event('qol-future', 'Harbour cruise', 86400000);
const past = event('qol-past', 'Previous museum trip', -86400000);
runtime.store.put('events', future);
runtime.store.put('events', past);
for (const [id, name, active, supportType] of [
  ['qol-active', 'Active Test Participant', true, 'none'],
  ['qol-inactive', 'Inactive Test Participant', false, 'both'],
] as const)
  runtime.store.put('participants', {
    id,
    name,
    active,
    supportType,
    initials: 'TP',
    notes: '',
    color: 'blue',
    airtableId: id === 'qol-active' ? 'rec11111111111111' : 'rec22222222222222',
  });
for (const [id, e, description, status] of [
  ['qol-upcoming', future, 'Event support', 'requested'],
  ['qol-ended', past, '', 'confirmed'],
  ['qol-declined', future, 'Declined future request', 'declined'],
] as const)
  runtime.store.put(
    'shifts',
    newShift(
      {
        participantId: 'qol-inactive',
        start: e.start,
        end: e.end,
        description,
        kind: id === 'qol-declined' ? 'general' : 'event',
        location: '',
        notes: '',
        driving: 'no_preference',
        gender: 'no_preference',
      },
      'client',
      false,
      { id, status, eventId: id === 'qol-declined' ? null : e.id },
    ),
  );
runtime.app.use(express.static(resolve('dist')));
const server = runtime.app.listen(3038, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const browser = await chromium.launch({
  executablePath: existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined,
  args: ['--no-sandbox'],
});
const artifacts = '/tmp/mtm-qol-browser';
mkdirSync(artifacts, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(origin);
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  assert(
    await page
      .locator('.brand img')
      .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
  );
  await page.screenshot({ path: artifacts + '/login.png', fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Staff workspace' }).click();
  const nav = async (name: RegExp) =>
    page.getByRole('navigation').getByRole('button', { name }).click();
  await nav(/^Requests/);
  await expect(page.getByRole('tab', { name: 'Upcoming', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('.shift-list-row').filter({ hasText: 'Harbour cruise' })).toBeVisible();
  await expect(
    page.locator('.shift-list-row').filter({ hasText: 'Previous museum trip' }),
  ).toHaveCount(0);
  await expect(
    page.locator('.shift-list-row').filter({ hasText: 'Declined future request' }),
  ).toHaveCount(0);
  await page.getByLabel('Search requests').fill('Harbour cruise');
  await page.locator('.shift-list-row').filter({ hasText: 'Harbour cruise' }).click();
  await expect(
    page.getByRole('dialog').getByRole('heading', { name: 'Harbour cruise' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByLabel('Search requests').fill('');
  await page.screenshot({
    path: artifacts + '/requests.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('tab', { name: 'Past / completed' }).click();
  await expect(
    page.locator('.shift-list-row').filter({ hasText: 'Previous museum trip' }),
  ).toBeVisible();
  await expect(
    page.locator('.shift-list-row').filter({ hasText: 'Declined future request' }),
  ).toBeVisible();
  await nav(/^Event support$/);
  await expect(page.locator('.event-card').filter({ hasText: 'Harbour cruise' })).toBeVisible();
  await expect(page.locator('.event-card').filter({ hasText: 'Previous museum trip' })).toHaveCount(
    0,
  );
  await page.getByRole('tab', { name: 'Past / completed' }).click();
  await expect(
    page.locator('.event-card').filter({ hasText: 'Previous museum trip' }),
  ).toBeVisible();
  await nav(/^Participants$/);
  await page.getByRole('checkbox', { name: /Show no regular support/ }).check();
  await expect(
    page.getByRole('heading', { name: 'Active Test Participant', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Inactive Test Participant', exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Request support for Active Test Participant', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/^Support type/).selectOption('event');
  await dialog.getByLabel(/^Event/).selectOption(future.id);
  await expect(dialog.getByLabel('What would you like support with?')).toHaveValue(
    'Support for Harbour cruise',
  );
  await dialog.getByRole('button', { name: 'Send support request' }).click();
  await expect(dialog).toHaveCount(0);
  const created = runtime.store
    .all('shifts')
    .find((s) => s.eventId === future.id && s.participantId === 'qol-active');
  assert(created);
  assert.equal(Date.parse(created.start), Date.parse(future.start) - 1800000);
  assert.equal(created.status, 'requested');
  for (const slogan of [
    'People first.',
    'Thoughtful support.',
    'A space built around you',
    'A plan built around their preferences.',
  ])
    await expect(page.getByText(slogan, { exact: false })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: artifacts + '/participants-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.locator('.sidebar.mobile-open .brand')).toBeVisible();
  assert(
    await page
      .locator('.sidebar .brand')
      .evaluate((el) => el.getBoundingClientRect().right <= innerWidth),
  );
  await page.screenshot({
    path: artifacts + '/mobile-navigation.png',
    fullPage: false,
    animations: 'disabled',
  });
  assert.deepEqual(errors, []);
  console.log(
    'Brand assets, event titles/search, upcoming/history views, active participants and manual event requests passed.',
  );
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  runtime.close();
}
