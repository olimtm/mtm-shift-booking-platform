import assert from 'node:assert/strict';
import test from 'node:test';
import { isActiveParticipant, isPastSupport, shiftTitle } from '../../shared/views.ts';
import { newShift } from '../domain.ts';
import type { Participant, SupportEvent } from '../../shared/types.ts';
const participant: Participant = {
  id: 'p',
  name: 'Test',
  initials: 'T',
  color: 'blue',
  supportType: 'none',
  notes: '',
};
const shift = newShift(
  {
    participantId: 'p',
    start: '2026-10-06T01:00:00Z',
    end: '2026-10-06T03:00:00Z',
    description: '',
    location: '',
    driving: 'no_preference',
    gender: 'no_preference',
    notes: '',
    kind: 'event',
  },
  'event',
  false,
  { eventId: 'e' },
);

test('upcoming includes in-progress shifts until their end; closed requests appear in history', () => {
  assert.equal(isPastSupport(shift, Date.parse('2026-10-06T02:00:00Z')), false);
  assert.equal(isPastSupport(shift, Date.parse(shift.end)), true);
  assert.equal(isPastSupport({ ...shift, status: 'cancelled' }, Date.parse(shift.start)), true);
  assert.equal(isPastSupport({ ...shift, status: 'declined' }, Date.parse(shift.start)), true);
});
test('active lifecycle is independent of support eligibility and linked unknowns stay out of the active list', () => {
  assert.equal(isActiveParticipant(participant), true);
  assert.equal(isActiveParticipant({ ...participant, airtableId: 'rec1' }), false);
  assert.equal(isActiveParticipant({ ...participant, airtableId: 'rec1', active: true }), true);
  assert.equal(isActiveParticipant({ ...participant, supportType: 'both', active: false }), false);
});
test('event titles come from the linked event even with empty legacy notes or generic descriptions', () => {
  const event: SupportEvent = {
    id: 'e',
    title: 'Harbour cruise',
    start: shift.start,
    end: shift.end,
    location: '',
    description: '',
    rsvpCount: 0,
    supportCount: 0,
  };
  assert.equal(shiftTitle(shift, [event]), 'Harbour cruise');
  assert.equal(
    shiftTitle({ ...shift, description: 'Event support', source: 'client' }, [event]),
    'Harbour cruise',
  );
  assert.equal(
    shiftTitle({ ...shift, eventId: null }, [event]),
    'Event support — event not linked',
  );
});
