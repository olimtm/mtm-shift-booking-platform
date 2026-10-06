import { chromium, expect, type Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import type { DashboardData } from '../shared/types.js';

// Run against a local DEMO_MODE server. This deliberately creates fictional
// requests/events: use a disposable database, never a live Airtable workspace.
const baseURL = process.env.BROWSER_BASE_URL || 'http://127.0.0.1:5173';
const artifacts = process.env.BROWSER_ARTIFACTS || '/tmp/mtm-browser';
mkdirSync(artifacts, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ||
    (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
  args: ['--no-sandbox'],
});
const errors: string[] = [];
const layoutErrors: string[] = [];
const run = Date.now().toString(36);
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
const clientContext = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
const staff = await context.newPage();
const client = await clientContext.newPage();
for (const page of [staff, client]) {
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('401 (Unauthorized)'))
      errors.push(`${message.text()} (${message.location().url})`);
  });
}
async function dashboard(page: Page): Promise<DashboardData> {
  const response = await page.request.get(`${baseURL}/api/dashboard`);
  assert.equal(response.status(), 200);
  return response.json();
}
async function screenshot(page: Page, name: string) {
  const width = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  if (width.document > width.viewport + 1)
    layoutErrors.push(`${name}: document ${width.document}px exceeds viewport ${width.viewport}px`);
  await page.screenshot({
    path: `${artifacts}/${name}.png`,
    fullPage: true,
    animations: 'disabled',
  });
}
async function nav(page: Page, label: RegExp) {
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: label })
    .click();
}
async function openRequest(page: Page, description: string) {
  await nav(page, /^Requests/);
  await page.getByRole('button', { name: 'All requests', exact: true }).click();
  await page.getByLabel('Search requests').fill(description);
  await page.locator('.shift-list-row').filter({ hasText: description }).click();
  return page.getByRole('dialog');
}
try {
  await staff.goto(baseURL);
  await expect(staff.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  const config = await (await staff.request.get(`${baseURL}/api/config`)).json();
  assert.equal(config.demoMode, true, 'Smoke checks are permitted only in explicit demo mode');
  await screenshot(staff, 'login-desktop');
  await staff.setViewportSize({ width: 390, height: 844 });
  await screenshot(staff, 'login-mobile');
  await staff.setViewportSize({ width: 1440, height: 1050 });
  await staff.getByLabel('Email address').fill('coordinator@mtm.demo');
  await staff.getByLabel('Password', { exact: true }).fill('DemoSupport!2026');
  await staff.getByLabel('Password', { exact: true }).press('Enter');
  await expect(staff.getByRole('heading', { name: 'Support schedule', exact: true })).toBeVisible();
  await screenshot(staff, 'staff-desktop');
  await staff.setViewportSize({ width: 390, height: 844 });
  await screenshot(staff, 'staff-mobile');
  await staff.getByRole('button', { name: 'Open navigation' }).click();
  await expect(staff.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await staff.getByRole('button', { name: 'Close navigation' }).last().click();
  await staff.setViewportSize({ width: 1440, height: 1050 });

  await client.goto(baseURL);
  await client.getByRole('button', { name: 'Client portal', exact: true }).click();
  await expect(client.getByRole('heading', { name: 'My support' })).toBeVisible();
  await screenshot(client, 'client-desktop');
  await client.setViewportSize({ width: 390, height: 844 });
  await screenshot(client, 'client-mobile');
  await client.getByRole('button', { name: 'List', exact: true }).click();
  await screenshot(client, 'client-mobile-list');
  await client.getByRole('button', { name: 'Week', exact: true }).click();
  await client.getByRole('button', { name: 'Request support', exact: true }).click();
  await screenshot(client, 'request-mobile');
  await client.getByRole('button', { name: 'Close dialog' }).click();
  await client.setViewportSize({ width: 1440, height: 1050 });
  const initial = await dashboard(client);
  assert.deepEqual(initial.participants.map((p) => p.id).sort(), ['p-alex', 'p-jamie']);
  assert(initial.shifts.every((shift) => ['p-alex', 'p-jamie'].includes(shift.participantId)));
  assert.equal(
    await client
      .getByRole('navigation')
      .getByRole('button', { name: 'Participants', exact: true })
      .count(),
    0,
  );
  assert.equal(await client.getByRole('button', { name: 'Airtable', exact: true }).count(), 0);

  // Dialog focus trapping, Escape, and return focus.
  const requestButton = client.getByRole('button', { name: 'Request support', exact: true });
  await requestButton.click();
  await client.keyboard.press('Shift+Tab');
  await expect(client.getByRole('button', { name: 'Send support request' })).toBeFocused();
  await client.keyboard.press('Tab');
  await expect(client.getByRole('button', { name: 'Close dialog' })).toBeFocused();
  await client.keyboard.press('Escape');
  await expect(client.getByRole('dialog')).toHaveCount(0);
  await expect(requestButton).toBeFocused();

  const priorRuns = (await dashboard(staff)).shifts.filter((shift) =>
    shift.description.startsWith('Browser smoke '),
  );
  const nextAvailable =
    Math.max(Date.now() + 14 * 86400000, ...priorRuns.map((shift) => Date.parse(shift.end))) +
    2 * 86400000;
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(nextAvailable));
  const description = `Browser smoke ${run}: shops and lunch`;
  await requestButton.click();
  let dialog = client.getByRole('dialog');
  assert.deepEqual(await dialog.getByLabel('Participant').locator('option').allTextContents(), [
    'Alex Morgan',
    'Jamie Chen',
  ]);
  await dialog.getByLabel('Participant').selectOption('p-alex');
  await dialog.getByLabel('Starts').fill(`${day}T10:00`);
  await dialog.getByLabel('Ends').fill(`${day}T09:00`);
  await dialog.getByLabel('What would you like support with?').fill(description);
  await dialog.getByLabel('Driving preference').selectOption('required');
  await dialog.getByLabel('Support worker preference').selectOption('male');
  const meetingPlace = 'Newcastle library; meet near the main entrance. '.repeat(12).trim();
  await dialog.getByLabel('Meeting place').fill(meetingPlace);
  await dialog.getByRole('button', { name: 'Send support request' }).click();
  await expect(dialog.getByRole('alert')).toContainText('end time must be after the start time');
  await dialog.getByLabel('Ends').fill(`${day}T13:00`);
  await dialog.getByRole('button', { name: 'Send support request' }).click();
  await expect(dialog).toHaveCount(0);
  let created = (await dashboard(client)).shifts.find((shift) => shift.description === description);
  assert(created);
  assert.equal(created.status, 'requested');
  assert.equal(created.driving, 'required');
  assert.equal(created.gender, 'male');
  assert.equal(created.location, meetingPlace, 'Long meeting instructions are preserved');
  const originalStart = created.start;
  await staff.reload();
  dialog = await openRequest(staff, description);
  await expect(dialog).toContainText('Driving worker');
  await expect(dialog).toContainText('Male worker');
  await dialog.getByLabel('Assigned support worker').selectOption('s-james');
  await dialog.getByRole('button', { name: 'Approve shift', exact: true }).click();
  await expect(dialog.locator('.status')).toHaveText('Confirmed');
  await dialog.getByRole('button', { name: 'Close dialog' }).click();

  await client.reload();
  dialog = await openRequest(client, description);
  await expect(dialog).toContainText('James Mitchell');
  await dialog.getByRole('button', { name: 'Request a change' }).click();
  dialog = client.getByRole('dialog');
  await dialog.getByLabel('Starts').fill(`${day}T11:00`);
  await dialog.getByLabel('Ends').fill(`${day}T14:00`);
  await dialog.getByRole('button', { name: 'Send change request' }).click();
  await expect(dialog).toHaveCount(0);
  created = (await dashboard(client)).shifts.find((shift) => shift.id === created!.id);
  assert(created);
  assert.equal(created.start, originalStart, 'Confirmed time remains until staff approve');
  assert.equal(created.status, 'confirmed');
  assert.equal(created.pendingChange?.type, 'edit');
  await staff.reload();
  dialog = await openRequest(staff, description);
  await expect(dialog).toContainText('The current shift stays in place');
  await dialog.getByRole('button', { name: 'Approve change', exact: true }).click();
  await expect(dialog.locator('.pending-change')).toHaveCount(0);
  const changed = (await dashboard(staff)).shifts.find((shift) => shift.id === created!.id)!;
  assert.notEqual(changed.start, originalStart);
  assert.equal(changed.pendingChange, null);
  await dialog.getByRole('button', { name: 'Close dialog' }).click();

  await client.reload();
  dialog = await openRequest(client, description);
  await dialog.getByRole('button', { name: 'Request a cancellation', exact: true }).click();
  await dialog
    .getByLabel('Reason for cancellation')
    .fill('Plans changed in this browser smoke test');
  await dialog.getByRole('button', { name: 'Request cancellation', exact: true }).click();
  await expect(dialog).toContainText('Cancellation requested');
  const cancellation = (await dashboard(client)).shifts.find((shift) => shift.id === created!.id)!;
  assert.equal(
    cancellation.status,
    'confirmed',
    'Client cancellation preserves the booking until approval',
  );
  assert.equal(cancellation.pendingChange?.type, 'cancel');
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await staff.reload();
  dialog = await openRequest(staff, description);
  await dialog.getByRole('button', { name: 'Approve change', exact: true }).click();
  await expect(dialog.locator('.status')).toHaveText('Cancelled');
  await dialog.getByRole('button', { name: 'Close dialog' }).click();

  await nav(staff, /^Support schedule$/);
  const filter = staff.getByLabel('Filter calendar by participant');
  assert.equal(await filter.locator('option[value="p-riley"]').count(), 0);
  await staff.getByLabel('Include participants with no regular support').check();
  await expect(filter.locator('option[value="p-riley"]')).toHaveCount(1);
  await staff.getByLabel('Include participants with no regular support').uncheck();
  await nav(staff, /^Participants$/);
  await expect(staff.getByRole('heading', { name: 'Riley Davis' })).toHaveCount(0);
  await staff.getByLabel('Show no regular support').check();
  await expect(staff.getByRole('heading', { name: 'Riley Davis' })).toBeVisible();
  await staff.getByRole('button', { name: 'Request support for Riley Davis' }).click();
  dialog = staff.getByRole('dialog');
  await expect(dialog.getByLabel('Participant')).toHaveValue('p-riley');
  await expect(dialog).toContainText('You can still request a one-off shift.');
  await dialog.getByLabel('What would you like support with?').fill(`One-off support ${run}`);
  await dialog.getByRole('button', { name: 'Send support request' }).click();
  await expect(dialog).toHaveCount(0);
  assert(
    (await dashboard(staff)).shifts.some(
      (shift) =>
        shift.description === `One-off support ${run}` && shift.participantId === 'p-riley',
    ),
  );

  await nav(staff, /^Support workers$/);
  await staff.getByRole('button', { name: 'Add worker', exact: true }).click();
  dialog = staff.getByRole('dialog');
  const workerName = `Browser worker ${run}`;
  await dialog.getByLabel('Worker name').fill(workerName);
  await dialog
    .getByLabel('Airtable Staff record ID')
    .fill(`rec${run.padStart(14, '0').slice(-14)}`);
  await screenshot(staff, 'worker-form-desktop');
  await staff.setViewportSize({ width: 390, height: 844 });
  await screenshot(staff, 'worker-form-mobile');
  await dialog.getByRole('button', { name: 'Save worker', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(staff.getByRole('heading', { name: workerName, exact: true })).toBeVisible();
  await screenshot(staff, 'workers-mobile');
  await staff.setViewportSize({ width: 1440, height: 1050 });
  await staff.getByRole('button', { name: `Edit worker ${workerName}`, exact: true }).click();
  dialog = staff.getByRole('dialog');
  await expect(dialog.getByLabel('Airtable Staff record ID')).toHaveAttribute('readonly', '');
  await dialog.getByLabel('Worker name').fill(`${workerName} Updated`);
  await dialog.getByRole('button', { name: 'Save worker', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  assert((await dashboard(staff)).staff.some((w) => w.name === `${workerName} Updated`));

  await nav(staff, /^Event support$/);
  await staff.getByRole('button', { name: 'Create event', exact: true }).click();
  dialog = staff.getByRole('dialog');
  const eventName = `Browser event ${run}`;
  await dialog.getByLabel('Event name').fill(eventName);
  await dialog.getByLabel('Starts', { exact: true }).fill(`${day}T15:00`);
  await dialog.getByLabel('Ends', { exact: true }).fill(`${day}T17:00`);
  await dialog.getByLabel('Location').fill('Newcastle');
  await dialog.getByRole('button', { name: 'Create event', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await staff.locator('.event-card').filter({ hasText: eventName }).click();
  dialog = staff.getByRole('dialog');
  await dialog.getByLabel('Add an RSVP').selectOption('p-alex');
  await dialog.getByRole('button', { name: 'Record RSVP' }).click();
  await expect(dialog.getByRole('heading', { name: 'Attending · 1' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Record RSVP' }).click();
  await expect(dialog.getByRole('button', { name: 'Record RSVP' })).toBeEnabled();
  const afterRsvp = await dashboard(staff);
  const event = afterRsvp.events.find((item) => item.title === eventName)!;
  const eventShifts = afterRsvp.shifts.filter((shift) => shift.eventId === event.id);
  assert.equal(eventShifts.length, 1, 'Repeated RSVP must not duplicate support');
  assert.equal(
    new Date(event.start).getTime() - new Date(eventShifts[0].start).getTime(),
    30 * 60000,
  );
  assert.equal(new Date(eventShifts[0].end).getTime() - new Date(event.end).getTime(), 30 * 60000);
  await dialog.getByLabel('Add an RSVP').selectOption('p-jamie');
  await dialog.getByRole('button', { name: 'Record RSVP' }).click();
  await expect(dialog.getByRole('heading', { name: 'Attending · 2' })).toBeVisible();
  assert.equal(
    (await dashboard(staff)).shifts.filter((shift) => shift.eventId === event.id).length,
    1,
    'General-only participants do not receive event support automatically',
  );
  assert.deepEqual(layoutErrors, [], 'No page-level horizontal overflow');
  assert.deepEqual(errors, [], 'No browser runtime/console errors');
  console.log(
    `Browser smoke passed: email/password + demo logins, participant scoping, desktop/mobile overflow, modal keyboard focus, request validation/preferences, approval/change/cancellation preservation, hidden participants/one-off staff requests, repeat RSVP idempotency and 30-minute padding. Screenshots: ${artifacts}`,
  );
} catch (error) {
  await staff
    .screenshot({ path: `${artifacts}/failure-staff.png`, fullPage: true })
    .catch(() => {});
  await client
    .screenshot({ path: `${artifacts}/failure-client.png`, fullPage: true })
    .catch(() => {});
  throw error;
} finally {
  await browser.close();
}
