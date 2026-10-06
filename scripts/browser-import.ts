import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';

// Exercise the import controls with fictional responses and an isolated in-memory demo.
for (const key of Object.keys(process.env))
  if (key.startsWith('AIRTABLE_')) delete process.env[key];
const { createApp } = await import('../server/app.js');
const origin = 'http://127.0.0.1:3037';
const application = createApp({
  databasePath: ':memory:',
  demoMode: true,
  enableSync: false,
  publicOrigin: origin,
});
application.app.use(express.static(resolve('dist')));
const server = application.app.listen(3037, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const browser = await chromium.launch({
  executablePath: existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined,
  args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/dashboard', async (route) => {
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const data = await response.json();
    data.demoMode = false;
    data.integration.configured = true;
    await route.fulfill({ json: data });
  });
  const requests: unknown[] = [];
  await page.route('**/api/integrations/airtable/import', async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      json: {
        message: 'Imported valid records. 1 RSVP omitted.',
        omittedRsvps: [
          {
            recordId: 'rec11111111111111',
            reason: 'Missing participant link',
            url: 'https://airtable.com/app12345678901234/tbl12345678901234/rec11111111111111',
          },
        ],
      },
    });
  });
  await page.goto(origin);
  await page.getByRole('button', { name: 'Staff workspace' }).click();
  await page.getByRole('button', { name: 'Airtable', exact: true }).click();
  const option = page.getByRole('checkbox', { name: /Import valid records/ });
  await expect(option).not.toBeChecked();
  await option.check();
  await page.getByRole('button', { name: 'Import initial data', exact: true }).click();
  await expect(page.getByText('Imported valid records. 1 RSVP omitted.')).toBeVisible();
  assert.deepEqual(requests, [{ omitInvalidRsvps: true }]);
  await page.getByText('Review 1 RSVP records with omitted attendance').click();
  await expect(page.getByRole('link', { name: 'rec11111111111111' })).toHaveAttribute(
    'href',
    /airtable.com/,
  );
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download import report' }).click();
  assert.equal((await download).suggestedFilename(), 'airtable-import-report.json');
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  assert.deepEqual(errors, []);
  console.log('Import option, submitted policy, report links, download and mobile layout passed.');
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  application.close();
}
