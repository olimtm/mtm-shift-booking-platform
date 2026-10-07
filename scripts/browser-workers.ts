import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import { createApp } from '../server/app.ts';
import { seedDemo } from '../server/seed.ts';
import { newShift } from '../server/domain.ts';
import { createConnecteamImport } from '../server/connecteam-import.ts';

// Isolated fictional data and a mocked read-only Airtable server. Never load .env.
for (const key of Object.keys(process.env))
  if (key.startsWith('AIRTABLE_')) delete process.env[key];
Object.assign(process.env, {
  CONNECTEAM_API_KEY: 'fictional-connecteam-browser-key',
  CONNECTEAM_SCHEDULER_NAME: 'NSW',
  AIRTABLE_PAT: 'fake-browser-worker-token',
  AIRTABLE_BASE_ID: 'app12345678901234',
  AIRTABLE_PARTICIPANTS_TABLE: 'Participants',
  AIRTABLE_SYNC_ENABLED: 'false',
});
delete process.env.CONNECTEAM_SCHEDULER_ID;
const metadata: {
  tables: Array<{ id: string; name: string; fields: Array<Record<string, unknown>> }>;
} = {
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
            choices: [
              'Active',
              'Active - Volunteer',
              'Pending Superannuation Xero Input',
              'Inactive',
            ].map((name) => ({ name })),
          },
        },
        { id: 'fldArchived', name: 'Archived', type: 'checkbox' },
        { name: 'Connecteam ID', type: 'number' },
      ],
    },
    {
      id: 'tblPeople',
      name: 'Participants',
      fields: [{ name: 'Connecteam Job ID', type: 'singleLineText' }],
    },
    {
      id: 'tblShifts',
      name: 'Shift Requests',
      fields: [{ name: 'Connecteam Shift ID', type: 'singleLineText' }],
    },
    {
      id: 'tblHistory',
      name: '1:1 Log',
      fields: [
        { name: 'Start', type: 'dateTime' },
        { name: 'End', type: 'dateTime' },
        {
          name: 'Progress Facilitator',
          type: 'multipleRecordLinks',
          options: { linkedTableId: 'tblStaff' },
        },
        {
          name: 'Participant',
          type: 'multipleRecordLinks',
          options: { linkedTableId: 'tblPeople' },
        },
        { name: 'Status', type: 'singleSelect' },
        { name: 'Is Live Shift', type: 'formula' },
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
  {
    id: 'rec44444444444444',
    fields: { Name: 'A Newcomer', Status: 'Pending Superannuation Xero Input', Archived: false },
  },
];
const historyRecords = [1, 2, 3].map((n) => ({
  id: `rec${String(n + 10).padStart(14, '0')}`,
  fields: {
    Start: new Date(Date.now() - n * 86400000 - 3600000).toISOString(),
    End: new Date(Date.now() - n * 86400000).toISOString(),
    'Progress Facilitator': [records[n === 3 ? 1 : 0].id],
    Participant: ['rec55555555555555'],
    'Is Live Shift': 1,
  },
}));
const originalFetch = globalThis.fetch;
let fail = false;
let connecteamDenied = false;
let duplicateConnecteamIds = false;
let connecteamGate: Promise<void> | undefined;
globalThis.fetch = async (resource, init) => {
  const url = new URL(String(resource));
  if (url.hostname === 'api.connecteam.com') {
    assert.equal(init?.method, 'GET');
    await connecteamGate;
    if (connecteamDenied) return new Response('private Connecteam response', { status: 401 });
    if (url.pathname.endsWith('/shifts'))
      return Response.json({
        data: {
          shifts: [
            {
              id: 'history-import',
              jobId: 'private-job-id',
              title: 'Imported historical support',
              startTime: Math.floor(Date.now() / 1000) - 20 * 86400,
              endTime: Math.floor(Date.now() / 1000) - 20 * 86400 + 3600,
              assignedUserIds: [1],
              isPublished: true,
              isOpenShift: false,
            },
            {
              id: 'unmapped-job',
              jobId: 'other-job',
              title: 'Unmapped admin shift',
              startTime: Math.floor(Date.now() / 1000) - 20 * 86400,
              endTime: Math.floor(Date.now() / 1000) - 20 * 86400 + 3600,
              assignedUserIds: [1],
              isPublished: true,
              isOpenShift: false,
            },
          ],
        },
      });
    return Response.json({
      data: {
        schedulers: [
          { schedulerId: 999, name: 'NSW', isArchived: false, timezone: 'Australia/Sydney' },
        ],
      },
    });
  }
  assert.equal(url.hostname, 'api.airtable.com');
  assert.equal(init?.method, undefined, 'worker refresh must never write to Airtable');
  if (fail) return new Response('private upstream response', { status: 401 });
  const selected = url.searchParams.getAll('fields[]');
  if (selected.length === 1 && selected[0] === 'Connecteam ID')
    return Response.json({
      records: records.map((r, i) => ({
        id: r.id,
        fields: { 'Connecteam ID': duplicateConnecteamIds ? 1 : i + 1 },
      })),
    });
  if (url.pathname.includes('tblPeople'))
    return Response.json({
      records: [{ id: 'rec55555555555555', fields: { 'Connecteam Job ID': 'private-job-id' } }],
    });
  if (url.pathname.includes('tblShifts')) return Response.json({ records: [] });
  return Response.json(
    url.pathname.includes('/meta/')
      ? metadata
      : { records: url.pathname.includes('tblHistory') ? historyRecords : records },
  );
};
const origin = 'http://127.0.0.1:3041';
const runtime = createApp({
  databasePath: ':memory:',
  demoMode: false,
  enableSync: false,
  publicOrigin: origin,
});
seedDemo(runtime.store);
runtime.store.put('participants', {
  ...runtime.store.get('participants', 'p-alex')!,
  airtableId: 'rec55555555555555',
  active: true,
});
await runtime.refreshWorkers();
await runtime.refreshWorkHistory();
// Production runs this on startup, so clicking Check often returns unchanged counts.
await runtime.connecteam.check();
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
  await expect(page.getByRole('heading', { name: 'A Newcomer', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Archived Worker', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit worker Roster Worker' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add worker', exact: true })).toHaveCount(0);
  await expect(page.getByText(/Last synced/)).toBeVisible();
  await page.screenshot({ path: artifacts + '/workers.png', fullPage: true });
  await nav(/^Requests/);
  await page.getByLabel('Search requests').fill(shift.description);
  await page.locator('.shift-list-row').filter({ hasText: shift.description }).click();
  const ranking = page.getByRole('dialog').getByLabel(/Assigned support worker/);
  const rankedIds = await ranking
    .locator('option')
    .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
  assert(rankedIds.indexOf(worker.id) < rankedIds.indexOf(volunteer.id));
  await expect(ranking.locator(`option[value="${worker.id}"]`)).toHaveText(
    '2 shifts · Roster Worker',
  );
  await expect(ranking.locator(`option[value="${volunteer.id}"]`)).toHaveText(
    '1 shift · Roster Volunteer',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: artifacts + '/assignment-history-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await nav(/^Support workers$/);
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
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Connecteam', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New shift request', exact: true })).toHaveCount(0);
  const result = page.getByRole('status').filter({ hasText: /Connection|Checking/ });
  await expect(result).toContainText('Connection verified.');
  // Both the first manual check and an unchanged repeat must visibly finish.
  for (let attempt = 0; attempt < 2; attempt++) {
    let release!: () => void;
    connecteamGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.getByRole('button', { name: 'Check Connecteam connection', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Checking connection…', exact: true }),
    ).toBeDisabled();
    await expect(result).toContainText('Checking Connecteam and Airtable links…');
    await expect(result).not.toContainText('Connection check complete.');
    release();
    connecteamGate = undefined;
    await expect(result).toContainText('Connection check complete.');
    await expect(result).toContainText('Connected to NSW. No mapping issues found.');
    await expect(result).toContainText('Shift publishing is still off.');
  }
  // A failure must remove the previous success, retain the last report and allow retry.
  connecteamDenied = true;
  await page.getByRole('button', { name: 'Check Connecteam connection', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Connecteam rejected the API key');
  await expect(result).toHaveCount(0);
  await expect(page.getByText('Scheduler 999', { exact: true })).toBeVisible();
  await expect(page.getByText('private Connecteam response')).toHaveCount(0);
  connecteamDenied = false;
  duplicateConnecteamIds = true;
  await page.getByRole('button', { name: 'Check Connecteam connection', exact: true }).click();
  await expect(result).toContainText('Some Airtable links need attention below.');
  await expect(result).not.toContainText('No mapping issues found.');
  await expect(page.getByRole('alert')).toContainText('share the same Connecteam ID');
  duplicateConnecteamIds = false;
  await page.getByRole('button', { name: 'Check Connecteam connection', exact: true }).click();
  await expect(result).toContainText('No mapping issues found.');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('Scheduler 999', { exact: true })).toBeVisible();
  await expect(page.getByText('Publishing off', { exact: true })).toBeVisible();
  await expect(page.getByText('private-job-id', { exact: true })).toHaveCount(0);
  assert.equal(runtime.connecteam.status().report?.mappedWorkers, 4);
  // Exercise the real import and report with fictional data. Durable backups have separate tests.
  const importer = createConnecteamImport(runtime.store, {
    databasePath: artifacts + '/fictional.sqlite',
    enabled: () => true,
    backup: async () => {},
  });
  await importer.run('preview', 'browser-once');
  await page.getByRole('button', { name: 'Check Connecteam connection', exact: true }).click();
  await expect(page.getByText('Import preview ready.', { exact: false })).toBeVisible();
  await importer.run('apply', 'browser-once');
  await page.getByRole('button', { name: 'Check Connecteam connection', exact: true }).click();
  await expect(page.getByText('Import completed.', { exact: false })).toBeVisible();
  await expect(
    page.getByText('1 added · 0 updated · 0 already matched · 0 cancelled'),
  ).toBeVisible();
  await page.getByText('View import exceptions', { exact: true }).click();
  await expect(page.getByText('Unmapped admin shift', { exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download full import report', exact: true }).click();
  assert.equal((await downloadPromise).suggestedFilename(), 'connecteam-import-report.json');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: artifacts + '/connecteam-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await nav(/^Requests/);
  await page.getByRole('tab', { name: 'Past / completed' }).click();
  await page.getByLabel('Search requests').fill('Imported historical support');
  await expect(
    page.locator('.shift-list-row').filter({ hasText: 'Imported historical support' }),
  ).toHaveCount(1);
  await page.locator('.shift-list-row').filter({ hasText: 'Imported historical support' }).click();
  await expect(page.getByText('Imported from Connecteam · Saved in portal only')).toBeVisible();
  assert.deepEqual(errors, []);
  console.log(
    'Worker browser checks passed: active staff/volunteers/payroll-pending staff, history counts and sorting, refresh, inactivity, preserved bookings, reassignment, Connecteam repeated-check feedback, failure recovery, mapping warnings and mobile layout.',
  );
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  runtime.close();
  globalThis.fetch = originalFetch;
}
