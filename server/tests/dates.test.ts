import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, dayKey, duration, inputDate, monday, zonedIso } from '../../client/dates.js';

test('Sydney calendar dates do not depend on the server or browser timezone', () => {
  assert.equal(dayKey('2026-10-03T23:30:00Z'), '2026-10-04');
  assert.equal(monday('2026-10-04'), '2026-09-28');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('shift inputs use the correct Sydney offset either side of daylight saving', () => {
  assert.equal(zonedIso('2026-10-03T09:00'), '2026-10-02T23:00:00.000Z');
  assert.equal(zonedIso('2026-10-04T09:00'), '2026-10-03T22:00:00.000Z');
  assert.equal(inputDate('2026-10-03T22:00:00Z'), '2026-10-04T09:00');
});

test('nonexistent Sydney spring-forward inputs are rejected instead of silently moved', () => {
  assert.throws(() => zonedIso('2026-10-04T02:30'), /daylight-saving/);
});

test('overnight support across a clock change reports elapsed hours', () => {
  const start = zonedIso('2026-10-03T23:00');
  const end = zonedIso('2026-10-04T04:00');
  assert.equal(duration(start, end), 4);
});
