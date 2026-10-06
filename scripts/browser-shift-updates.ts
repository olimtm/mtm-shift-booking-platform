import { chromium, expect, type Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import { createApp } from '../server/app.ts';
import { hashPassword } from '../server/auth.ts';
import { newShift } from '../server/domain.ts';
import type { DashboardData } from '../shared/types.ts';

for (const key of Object.keys(process.env))
  if (key.startsWith('AIRTABLE_')) delete process.env[key];
process.env.NODE_ENV = 'development';
const origin = 'http://127.0.0.1:3043';
const runtime = createApp({
  databasePath: ':memory:',
  demoMode: false,
  enableSync: false,
  publicOrigin: origin,
});
const password = 'Fictional-browser-password!2026';
for (const [id, name, role, participantIds] of [
  ['coordinator', 'Fictional Coordinator', 'staff', []],
  ['parent', 'Fictional Parent', 'client', ['p-one']],
] as const)
  runtime.store.putUser({
    id,
    name,
    role,
    participantIds: [...participantIds],
    email: `${id}@example.test`,
    passwordHash: hashPassword(password),
  });
for (const [id, name] of [
  ['w-one', 'Fictional Worker'],
  ['w-two', 'Other Worker'],
])
  runtime.store.put('staff', { id, name, initials: 'W', color: 'blue', active: true });
runtime.store.put('participants', {
  id: 'p-one',
  name: 'Fictional Alex',
  initials: 'FA',
  color: 'blue',
  notes: 'PRIVATE_PARTICIPANT',
  supportType: 'both',
});
const now = Date.now();
for (const [id, offset, staffId] of [
  ['past', -86400000, 'w-one'],
  ['future', 86400000, 'w-one'],
  ['other', -86400000, 'w-two'],
] as const)
  runtime.store.put(
    'shifts',
    newShift(
      {
        participantId: 'p-one',
        start: new Date(now + offset - 3600000).toISOString(),
        end: new Date(now + offset).toISOString(),
        description: `${id} support`,
        location: 'Library',
        notes: '',
        kind: 'general',
        driving: 'no_preference',
        gender: 'no_preference',
      },
      'staff',
      false,
      { id, staffId, status: 'confirmed' },
    ),
  );
runtime.app.use(express.static(resolve('dist')));
const server = runtime.app.listen(3043, '127.0.0.1');
await new Promise<void>((resolve, reject) => {
  server.once('listening', resolve);
  server.once('error', reject);
});
const browser = await chromium.launch({
  executablePath: existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined,
  args: ['--no-sandbox'],
});
const artifacts = '/tmp/mtm-shift-updates-browser';
mkdirSync(artifacts, { recursive: true });
const errors: string[] = [];
async function page() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  return page;
}
async function login(page: Page, account: string) {
  await page.goto(origin);
  await page.getByLabel('Email address').fill(`${account}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
async function nav(page: Page, name: string) {
  await page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
}
async function screenshot(page: Page, name: string, mobile = false) {
  assert.equal(await page.getByLabel('Private access link').count(), 0);
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1100 });
  await page.evaluate(() => document.fonts.ready);
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    `${name} has horizontal overflow`,
  );
  if (mobile)
    assert(
      await page
        .locator('textarea, select, input:not([type=checkbox])')
        .evaluateAll((nodes) =>
          nodes.every(
            (node) =>
              !node.getClientRects().length || parseFloat(getComputedStyle(node).fontSize) >= 16,
          ),
        ),
      `${name} has small mobile inputs`,
    );
  await page.screenshot({
    path: `${artifacts}/${name}.png`,
    fullPage: true,
    animations: 'disabled',
  });
}
try {
  const coordinator = await page(),
    worker = await page(),
    parent = await page();
  await login(coordinator, 'coordinator');
  await nav(coordinator, 'People & access');
  await coordinator.getByRole('button', { name: 'Invite someone' }).click();
  let dialog = coordinator.getByRole('dialog');
  await dialog.getByLabel('Full name').fill('Fictional Worker');
  await dialog.getByLabel('Email address').fill('worker@example.test');
  await dialog.getByLabel('Account type').selectOption('worker');
  await expect(dialog.getByRole('button', { name: 'Create invitation link' })).toBeDisabled();
  await dialog.getByLabel('Linked support worker').selectOption('w-one');
  await screenshot(coordinator, 'invite-worker-mobile', true);
  await dialog.getByRole('button', { name: 'Create invitation link' }).click();
  const link = await dialog.getByLabel('Private access link').inputValue();
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await worker.goto(link);
  await worker.getByLabel('New password', { exact: true }).fill(password);
  await worker.getByLabel('Confirm password').fill(password);
  await worker.getByRole('button', { name: 'Activate my account' }).click();
  await expect(worker.getByRole('heading', { name: 'My shifts', exact: true })).toBeVisible();
  assert.equal(new URL(worker.url()).hash, '');
  await expect(worker.getByRole('button', { name: 'People & access' })).toHaveCount(0);
  await expect(worker.getByText('future support', { exact: true })).toBeVisible();
  await expect(worker.getByText('other support', { exact: true })).toHaveCount(0);
  await worker.getByRole('button', { name: 'Shift details', exact: true }).click();
  await expect(worker.getByRole('button', { name: 'Request a change' })).toHaveCount(0);
  await expect(worker.getByRole('button', { name: 'Request a cancellation' })).toHaveCount(0);
  await worker.getByRole('button', { name: 'Close dialog' }).click();
  await screenshot(worker, 'worker-upcoming-desktop');
  await screenshot(worker, 'worker-upcoming-mobile', true);
  await worker.getByRole('tab', { name: /Updates to complete/ }).click();
  await worker.getByRole('button', { name: 'Write post-shift update' }).click();
  dialog = worker.getByRole('dialog');
  await dialog.getByLabel('What did we do?').fill('Visited the library and had lunch.');
  await dialog
    .getByLabel('How did it go?')
    .fill('Alex chose books and ordered lunch with one prompt.');
  await dialog.getByLabel('The participant provided feedback').check();
  await dialog.getByLabel('Participant’s feedback').fill('Alex said they would like to return.');
  await dialog.getByLabel('Goal or skill 1').fill('Ordering lunch independently');
  await dialog.getByRole('combobox', { name: /^Progress 1/ }).selectOption('progress');
  await dialog
    .getByLabel('Example from this shift 1')
    .fill('Placed the order with one verbal prompt.');
  await dialog.getByLabel('For next time').fill('Allow more time to browse.');
  await dialog.getByLabel('Internal handover notes').fill('PRIVATE_HANDOVER');
  await dialog.getByLabel('Coordinator follow-up needed').check();
  await dialog.getByLabel('Follow-up needed', { exact: true }).fill('PRIVATE_FOLLOWUP');
  await dialog.getByLabel(/Incident report reference/).fill('PRIVATE_INCIDENT');
  await screenshot(worker, 'post-shift-form-mobile', true);
  await screenshot(worker, 'post-shift-form-desktop');
  await dialog.getByRole('button', { name: 'Preview shared update' }).click();
  await expect(dialog.getByText('PRIVATE_HANDOVER')).toHaveCount(0);
  await expect(dialog.getByText('Made progress', { exact: true })).toBeVisible();
  await screenshot(worker, 'shared-preview-mobile', true);
  await dialog.getByRole('button', { name: 'Submit & share update' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(worker.getByRole('heading', { name: 'You’re up to date' })).toBeVisible();
  await login(parent, 'parent');
  const parentData: DashboardData = await (
    await parent.request.get(origin + '/api/dashboard')
  ).json();
  assert.equal(parentData.shiftUpdates?.length, 1);
  assert(!JSON.stringify(parentData).includes('PRIVATE_'));
  await nav(parent, 'Shift updates');
  await parent.locator('.update-card').click();
  await expect(parent.getByText('Ordering lunch independently', { exact: true })).toBeVisible();
  await expect(parent.getByText('Internal only', { exact: true })).toHaveCount(0);
  await expect(parent.getByRole('button', { name: 'Edit update' })).toHaveCount(0);
  await screenshot(parent, 'family-update-desktop');
  await screenshot(parent, 'family-update-mobile', true);
  await worker.getByRole('tab', { name: 'Completed', exact: true }).click();
  await worker.getByRole('button', { name: 'View update', exact: true }).click();
  await worker.getByRole('button', { name: 'Edit update', exact: true }).click();
  await worker
    .getByLabel('What did we do?')
    .fill('Visited the library, had lunch and took a walk.');
  await worker.getByRole('button', { name: 'Preview shared update' }).click();
  await worker.getByRole('button', { name: 'Save & share changes' }).click();
  await expect(worker.getByRole('dialog')).toHaveCount(0);
  const history = await (
    await parent.request.get(origin + '/api/shifts/past/update/history')
  ).json();
  assert.equal(history.versions.length, 2);
  assert(!JSON.stringify(history).includes('PRIVATE_'));
  await parent.getByRole('button', { name: 'Revision history' }).click();
  await expect(parent.getByLabel('Revision history').locator('details')).toHaveCount(2);
  await parent.getByText(/Revision 1 · Fictional Worker/).click();
  await expect(
    parent
      .getByLabel('Revision history')
      .getByText('Visited the library and had lunch.', { exact: true }),
  ).toBeVisible();
  await coordinator.setViewportSize({ width: 1440, height: 1100 });
  await coordinator.reload();
  await nav(coordinator, 'Shift updates');
  await coordinator.getByRole('tab', { name: 'Follow-up needed' }).click();
  await coordinator.locator('.update-card').click();
  await expect(coordinator.getByText('PRIVATE_HANDOVER', { exact: true })).toBeVisible();
  await expect(coordinator.getByText('PRIVATE_FOLLOWUP', { exact: false })).toBeVisible();
  await screenshot(coordinator, 'coordinator-followup-desktop');
  await coordinator.getByRole('button', { name: 'Edit update', exact: true }).click();
  await coordinator.getByLabel('Coordinator follow-up needed').uncheck();
  await coordinator.getByRole('button', { name: 'Preview shared update' }).click();
  await coordinator.getByRole('button', { name: 'Save & share changes' }).click();
  await expect(coordinator.getByRole('heading', { name: 'No follow-up flagged' })).toBeVisible();
  await worker.getByRole('button', { name: 'Sign out' }).click();
  await login(worker, 'worker');
  await expect(worker.getByRole('heading', { name: 'My shifts', exact: true })).toBeVisible();
  assert.deepEqual(errors, []);
  console.log(
    'Post-shift browser checks passed: worker invitation/login, assigned-only shifts, goals, preview, immediate family publication, private notes, revision history, coordinator follow-up, desktop/mobile layouts.',
  );
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  runtime.close();
}
