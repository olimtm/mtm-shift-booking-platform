import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import { createApp } from '../server/app.ts';
import { seedDemo } from '../server/seed.ts';
import { newShift } from '../server/domain.ts';

// Isolated fictional data and a mocked read-only Airtable server. Never load .env.
for (const key of Object.keys(process.env))
  if (key.startsWith('AIRTABLE_')) delete process.env[key];
Object.assign(process.env, {
  AIRTABLE_PAT: 'fake-browser-worker-token',
  AIRTABLE_BASE_ID: 'app12345678901234',
  AIRTABLE_PARTICIPANTS_TABLE: 'Participants',
  AIRTABLE_SYNC_ENABLED: 'false',
});
const metadata = {
  tables: [
    {
      id: 'tblStaff',
      name: 'Staff',
      fields: [
        { id: 'fldName', name: 'Name', type: 'singleLineText' },
        {
          id: 'fldStatus',
          name: 'Status',
          type: 'singleSelect',
          options: {
            choices: ['Active', 'Active - Volunteer', 'Inactive'].map((name) => ({ name })),
          },
        },
        { id: 'fldArchived', name: 'Archived', type: 'checkbox' },
      ],
    },
  ],
};
const records = [
  { id: 'rec11111111111111', fields: { Name: 'Roster Worker', Status: 'Active', Archived: false } },
  {
    id: 'rec22222222222222',
    fields: { Name: 'Roster Volunteer', Status: 'Active - Volunteer', Archived: false },
  },
  {
    id: 'rec33333333333333',
    fields: { Name: 'Archived Worker', Status: 'Active', Archived: true },
  },
];
const originalFetch = globalThis.fetch;
let fail = false;
globalThis.fetch = async (resource, init) => {
  const url = new URL(String(resource));
  assert.equal(url.hostname, 'api.airtable.com');
  assert.equal(init?.method, undefined, 'worker refresh must never write to Airtable');
  if (fail) return new Response('private upstream response', { status: 401 });
  return Response.json(url.pathname.includes('/meta/') ? metadata : { records });
};
const origin = 'http://127.0.0.1:3041';
const runtime = createApp({
  databasePath: ':memory:',
  demoMode: false,
  enableSync: false,
  publicOrigin: origin,
});
seedDemo(runtime.store);
await runtime.refreshWorkers();
const worker = runtime.store.all('staff').find((w) => w.airtableId === records[0].id)!;
const volunteer = runtime.store.all('staff').find((w) => w.airtableId === records[1].id)!;
const start = Date.now() + 10 * 86400000;
const shift = newShift(
  {
    participantId: 'p-alex',
    start: new Date(start).toISOString(),
    end: new Date(start + 3600000).toISOString(),
    description: 'Worker roster browser booking',
    location: '',
    notes: '',
    driving: 'no_preference',
    gender: 'no_preference',
    kind: 'general',
  },
  'staff',
  false,
  { staffId: worker.id, status: 'confirmed' },
);
runtime.store.put('shifts', shift);
runtime.app.use(express.static(resolve('dist')));
const server = runtime.app.listen(3041, '127.0.0.1');
await new Promise<void>((resolve, reject) => {
  server.once('listening', resolve);
  server.once('error', reject);
});
const browser = await chromium.launch({
  executablePath: existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined,
  args: ['--no-sandbox'],
});
const artifacts = '/tmp/mtm-workers-browser';
mkdirSync(artifacts, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(origin);
  await page.getByLabel('Email address').fill('coordinator@mtm.demo');
  await page.getByLabel('Password', { exact: true }).fill('DemoSupport!2026');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const nav = async (name: RegExp) =>
    page.getByRole('navigation').getByRole('button', { name }).click();
  await nav(/^Support workers$/);
  await expect(page.getByRole('heading', { name: 'Roster Worker', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Roster Volunteer', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Archived Worker', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit worker Roster Worker' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add worker', exact: true })).toHaveCount(0);
  await expect(page.getByText(/Last synced/)).toBeVisible();
  await page.screenshot({ path: artifacts + '/workers.png', fullPage: true });
  records[0].fields.Status = 'Inactive';
  records[1].fields.Name = 'Renamed Volunteer';
  await page.getByRole('button', { name: 'Refresh workers', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Roster Worker', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Renamed Volunteer', exact: true })).toBeVisible();
  assert.equal(runtime.store.get('shifts', shift.id)?.staffId, worker.id);
  assert.equal(runtime.store.get('shifts', shift.id)?.status, 'confirmed');
  await nav(/^Requests/);
  await page.getByLabel('Search requests').fill(shift.description);
  await page.locator('.shift-list-row').filter({ hasText: shift.description }).click();
  const dialog = page.getByRole('dialog');
  const assignment = dialog.getByLabel(/Assigned support worker/);
  await expect(assignment.locator(`option[value="${worker.id}"]`)).toHaveJSProperty(
    'disabled',
    true,
  );
  await expect(assignment).toHaveValue(worker.id);
  await expect(dialog.getByText(/This worker is no longer active/)).toBeVisible();
  await assignment.selectOption(volunteer.id);
  await dialog.getByRole('button', { name: /Save assignment/ }).click();
  await expect.poll(() => runtime.store.get('shifts', shift.id)?.staffId).toBe(volunteer.id);
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await nav(/^Support workers$/);
  fail = true;
  await page.getByRole('button', { name: 'Refresh workers', exact: true }).click();
  await expect(page.getByText(/Airtable rejected the personal access token/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Renamed Volunteer', exact: true })).toBeVisible();
  await expect(page.getByText('private upstream response')).toHaveCount(0);
  fail = false;
  records[0].fields.Status = 'Active';
  await page.getByRole('button', { name: 'Refresh workers', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Roster Worker', exact: true })).toBeVisible();
  await expect(page.getByText(/Airtable rejected the personal access token/)).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: artifacts + '/workers-mobile.png', fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  assert.deepEqual(errors, []);
  console.log(
    'Worker browser checks passed: active staff/volunteers, refresh, rename, inactivity, preserved bookings, reassignment, error recovery and mobile layout.',
  );
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  runtime.close();
  globalThis.fetch = originalFetch;
}
