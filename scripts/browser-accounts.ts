import { chromium, expect, type Page, type BrowserContext } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import type { DashboardData } from '../shared/types.js';

// Self-contained non-demo account UI checks. This runner owns its server/store,
// never loads .env, removes Airtable bindings, and never prints access tokens.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('AIRTABLE_')) delete process.env[key];
}
process.env.NODE_ENV = 'development';
process.env.AIRTABLE_SYNC_ENABLED = 'false';
const { createApp } = await import('../server/app.js');
const { Store } = await import('../server/db.js');
const directory = mkdtempSync(join(tmpdir(), 'mtm-account-browser-'));
const databasePath = join(directory, 'isolated.sqlite');
const artifacts = process.env.ACCOUNT_BROWSER_ARTIFACTS || '/tmp/mtm-browser/accounts';
mkdirSync(artifacts, { recursive: true });
const fixture = new Store(databasePath);
for (const [id, name, supportType] of [
  ['p-first', 'Fictional Alex', 'both'],
  ['p-second', 'Fictional Jamie', 'general'],
  ['p-third', 'Fictional Riley', 'none'],
] as const)
  fixture.put('participants', { id, name, supportType, initials: 'FP', color: 'green', notes: '' });
fixture.close();
const port = Number(process.env.ACCOUNT_BROWSER_PORT || 3012);
const origin = `http://127.0.0.1:${port}`;
const setupSecret = randomBytes(32).toString('hex');
const passwords = {
  first: randomBytes(24).toString('hex'),
  second: randomBytes(24).toString('hex'),
  client: randomBytes(24).toString('hex'),
  reset: randomBytes(24).toString('hex'),
};
const application = createApp({
  databasePath,
  demoMode: false,
  publicOrigin: origin,
  setupSecret,
  enableSync: false,
});
application.app.use(express.static(resolve('dist'), { index: false }));
application.app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
const server = application.app.listen(port, '127.0.0.1');
await new Promise<void>((resolveReady, reject) => {
  server.once('listening', resolveReady);
  server.once('error', reject);
});
const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ||
    (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
  args: ['--no-sandbox'],
});
const runtimeErrors: string[] = [];
const contexts: BrowserContext[] = [];
let stage = 'initial setup';
async function page() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  contexts.push(context);
  const result = await context.newPage();
  result.on('pageerror', (error) => runtimeErrors.push(error.message));
  result.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('401 (Unauthorized)'))
      runtimeErrors.push(message.text());
  });
  return result;
}
async function screenshot(page: Page, name: string, mobile = false) {
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1050 });
  // Never capture a link dialog, including unexpected failures.
  assert.equal(
    await page.getByLabel('Private access link').count(),
    0,
    'Access links must never be included in screenshots',
  );
  await page.evaluate(() => document.fonts.ready);
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    `${name} has horizontal overflow`,
  );
  await page.screenshot({
    path: join(artifacts, `${name}.png`),
    fullPage: true,
    animations: 'disabled',
  });
}
async function login(page: Page, email: string, password: string) {
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
async function data(page: Page): Promise<DashboardData> {
  const response = await page.request.get(`${origin}/api/dashboard`);
  assert.equal(response.status(), 200);
  return response.json();
}
async function accounts(page: Page) {
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'People & access', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'People & access', exact: true })).toBeVisible();
}
function row(page: Page, name: string) {
  return page
    .locator('.account-row')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });
}
async function invite(page: Page, name: string, email: string, role: 'staff' | 'client') {
  await page.getByRole('button', { name: 'Invite someone', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Full name').fill(name);
  await dialog.getByLabel('Email address').fill(email);
  await dialog.getByLabel('Account type').selectOption(role);
  if (role === 'client') {
    await expect(dialog.getByRole('button', { name: 'Create invitation link' })).toBeDisabled();
    await dialog.getByLabel('Fictional Alex', { exact: true }).check();
    await dialog.getByLabel('Fictional Jamie', { exact: true }).check();
    await screenshot(page, 'client-invite-mobile', true);
    await page.setViewportSize({ width: 1440, height: 1050 });
  }
  await dialog.getByRole('button', { name: 'Create invitation link' }).click();
  await expect(dialog.getByLabel('Private access link')).toBeVisible();
  const url = await dialog.getByLabel('Private access link').inputValue();
  assert(url.startsWith(`${origin}/#invite=`), 'Invitation origin must match isolated server');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  return url;
}
async function accept(page: Page, url: string, password: string, reset = false) {
  await page.goto(url);
  await expect(
    page.getByRole('heading', {
      name: reset ? 'Reset your password' : 'Create your account',
    }),
  ).toBeVisible();
  await expect(page.getByLabel('New password')).toBeVisible();
  if (!reset) await screenshot(page, 'accept-invite-mobile', true);
  await page.getByLabel('New password').fill(password);
  await page.getByLabel('Confirm password').fill(password);
  await page
    .getByRole('button', { name: reset ? 'Save password and sign in' : 'Activate my account' })
    .click();
  await expect(page.getByRole('heading', { name: /^(Support schedule|My support)/ })).toBeVisible();
  assert.equal(
    new URL(page.url()).hash,
    '',
    'The secret token must leave the address bar after activation',
  );
  await page.setViewportSize({ width: 1440, height: 1050 });
}
try {
  const coordinator = await page();
  await coordinator.goto(origin);
  await expect(
    coordinator.getByRole('heading', { name: 'Set up coordinator account' }),
  ).toBeVisible();
  await screenshot(coordinator, 'first-setup-desktop');
  await screenshot(coordinator, 'first-setup-mobile', true);
  await coordinator.setViewportSize({ width: 1440, height: 1050 });
  await coordinator.getByLabel('Your name').fill('Fictional Coordinator');
  await coordinator.getByLabel('Email address').fill('coordinator@browser.invalid');
  await coordinator.getByLabel('Choose a password').fill(passwords.first);
  await coordinator.getByLabel('Confirm password').fill(`${passwords.first}x`);
  await coordinator.getByLabel('Private setup key').fill(setupSecret);
  await coordinator.getByRole('button', { name: 'Create my workspace' }).click();
  await expect(coordinator.getByRole('alert')).toContainText('passwords don’t match');
  await coordinator.getByLabel('Confirm password').fill(passwords.first);
  await coordinator.getByRole('button', { name: 'Create my workspace' }).click();
  await expect(
    coordinator.getByRole('heading', { name: 'Support schedule', exact: true }),
  ).toBeVisible();
  assert.equal((await data(coordinator)).user.role, 'staff');
  assert.equal((await data(coordinator)).integration.configured, false);
  await coordinator.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(coordinator.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await login(coordinator, 'coordinator@browser.invalid', passwords.first);
  await accounts(coordinator);
  await expect(
    coordinator
      .locator('.account-row')
      .first()
      .getByRole('button', { name: 'Disable access', exact: true }),
  ).toBeDisabled();

  stage = 'coordinator invitation';
  const coordinatorLink = await invite(
    coordinator,
    'Fictional Second',
    'second@browser.invalid',
    'staff',
  );
  const second = await page();
  await accept(second, coordinatorLink, passwords.second);
  await accounts(second);
  assert.equal((await second.request.get(`${origin}/api/accounts`)).status(), 200);
  assert.equal((await data(second)).participants.length, 3);

  stage = 'client invitation and participant permissions';
  const clientLink = await invite(
    coordinator,
    'Fictional Representative',
    'client@browser.invalid',
    'client',
  );
  const client = await page();
  await accept(client, clientLink, passwords.client);
  assert.deepEqual((await data(client)).participants.map((p) => p.id).sort(), [
    'p-first',
    'p-second',
  ]);
  assert.equal(
    await client.getByRole('button', { name: 'People & access', exact: true }).count(),
    0,
  );
  assert.equal((await client.request.get(`${origin}/api/accounts`)).status(), 403);
  await coordinator.reload();
  await accounts(coordinator);
  await screenshot(coordinator, 'accounts-desktop');
  await screenshot(coordinator, 'accounts-mobile', true);
  await row(coordinator, 'Fictional Representative')
    .getByRole('button', { name: 'Edit access' })
    .click();
  await screenshot(coordinator, 'edit-access-mobile', true);
  const access = coordinator.getByRole('dialog');
  await access.getByLabel('Fictional Alex', { exact: true }).uncheck();
  await access.getByLabel('Fictional Riley').check();
  await access.getByRole('button', { name: 'Save access' }).click();
  await expect(access).toHaveCount(0);
  assert.equal(
    (await client.request.get(`${origin}/api/dashboard`)).status(),
    401,
    'Changing grants revokes existing client sessions',
  );
  await client.reload();
  await expect(client.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await login(client, 'client@browser.invalid', passwords.client);
  await expect(client.getByRole('heading', { name: 'My support' })).toBeVisible();
  assert.deepEqual((await data(client)).participants.map((p) => p.id).sort(), [
    'p-second',
    'p-third',
  ]);
  await coordinator.setViewportSize({ width: 1440, height: 1050 });

  stage = 'password reset and session revocation';
  await row(coordinator, 'Fictional Representative')
    .getByRole('button', { name: 'Password link' })
    .click();
  const resetUrl = await coordinator.getByLabel('Private access link').inputValue();
  await coordinator.getByRole('dialog').getByRole('button', { name: 'Done', exact: true }).click();
  const resetClient = await page();
  await accept(resetClient, resetUrl, passwords.reset, true);
  assert.equal(
    (await client.request.get(`${origin}/api/dashboard`)).status(),
    401,
    'Reset revokes previously active sessions',
  );
  await client.reload();
  await expect(client.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await login(client, 'client@browser.invalid', passwords.client);
  await expect(client.getByRole('alert')).toBeVisible();
  await expect(client.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await login(client, 'client@browser.invalid', passwords.reset);
  await expect(client.getByRole('heading', { name: 'My support' })).toBeVisible();

  stage = 'disabled account enforcement';
  await row(coordinator, 'Fictional Representative')
    .getByRole('button', { name: 'Disable access', exact: true })
    .click();
  await expect(row(coordinator, 'Fictional Representative')).toContainText('Access inactive');
  assert.equal((await client.request.get(`${origin}/api/dashboard`)).status(), 401);
  assert.equal((await resetClient.request.get(`${origin}/api/dashboard`)).status(), 401);
  await client.reload();
  await expect(client.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await login(client, 'client@browser.invalid', passwords.reset);
  await expect(client.getByRole('alert')).toBeVisible();
  await expect(client.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await row(coordinator, 'Fictional Second')
    .getByRole('button', { name: 'Disable access', exact: true })
    .click();
  await expect(row(coordinator, 'Fictional Second')).toContainText('Access inactive');
  assert.equal((await second.request.get(`${origin}/api/accounts`)).status(), 401);
  assert.deepEqual(runtimeErrors, [], 'No browser runtime errors');
  console.log(
    `Account browser checks passed: initial setup, mismatch validation, login/logout, coordinator and client invitations, activation, participant grants, access change revocation, reset/password/session revocation, disabling both roles, and desktop/mobile layouts. Screenshots: ${artifacts}`,
  );
} catch (error) {
  // Tokens and passwords stay out of logs, even if Playwright records a failed navigation.
  let message = error instanceof Error ? error.message : 'Unknown browser failure';
  for (const secret of [setupSecret, ...Object.values(passwords)])
    message = message.replaceAll(secret, '[redacted]');
  message = message.replace(/#invite=[a-f0-9]{64}/g, '#invite=[redacted]');
  throw new Error(`Account browser stage ${stage}: ${message}`);
} finally {
  await Promise.all(contexts.map((context) => context.close()));
  await browser.close();
  await new Promise<void>((resolveClosed) => server.close(() => resolveClosed()));
  application.close();
  rmSync(directory, { recursive: true, force: true });
}
