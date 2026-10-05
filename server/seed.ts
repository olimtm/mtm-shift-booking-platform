import type { Store } from './db.js';
import { hashPassword } from './auth.js';
import { upsertRsvp } from './domain.js';
import type { Participant, StaffMember, Shift, SupportEvent } from '../shared/types.js';

export function seedDemo(store: Store) {
  if (store.meta('demoSeeded')) return;
  const participants: Participant[] = [
    {
      id: 'p-alex',
      name: 'Alex Morgan',
      initials: 'AM',
      color: 'violet',
      supportType: 'both',
      notes: 'Enjoys cooking, local walks and community events.',
    },
    {
      id: 'p-jamie',
      name: 'Jamie Chen',
      initials: 'JC',
      color: 'blue',
      supportType: 'general',
      notes: 'Prefers a consistent weekly routine.',
    },
    {
      id: 'p-taylor',
      name: 'Taylor Brooks',
      initials: 'TB',
      color: 'peach',
      supportType: 'events',
      notes: 'Enjoys social activities and live music.',
    },
    {
      id: 'p-morgan',
      name: 'Morgan Lee',
      initials: 'ML',
      color: 'green',
      supportType: 'both',
      notes: 'Please allow time to settle into new activities.',
    },
    {
      id: 'p-jordan',
      name: 'Jordan Patel',
      initials: 'JP',
      color: 'pink',
      supportType: 'general',
      notes: 'Community access and independent living.',
    },
    {
      id: 'p-sam',
      name: 'Sam Wilson',
      initials: 'SW',
      color: 'blue',
      supportType: 'events',
      notes: 'Likes group outings and outdoor events.',
    },
    {
      id: 'p-riley',
      name: 'Riley Davis',
      initials: 'RD',
      color: 'peach',
      supportType: 'none',
      notes: 'Currently not receiving regular support.',
    },
  ];
  const staff: StaffMember[] = [
    { id: 's-emma', name: 'Emma Wilson', initials: 'EW', color: 'green' },
    { id: 's-james', name: 'James Mitchell', initials: 'JM', color: 'blue' },
    { id: 's-sophie', name: 'Sophie Taylor', initials: 'ST', color: 'pink' },
    { id: 's-liam', name: 'Liam Anderson', initials: 'LA', color: 'peach' },
  ];
  // Offset is derived for each date, so Sydney daylight-saving changes remain correct.
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const date = new Date(`${today}T00:00:00Z`);
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  const at = (day: number, hour: number) => {
    const target = new Date(monday);
    target.setUTCDate(target.getUTCDate() + day);
    target.setUTCHours(hour);
    const tz =
      new Intl.DateTimeFormat('en-US', { timeZone: 'Australia/Sydney', timeZoneName: 'longOffset' })
        .formatToParts(target)
        .find((part) => part.type === 'timeZoneName')?.value ?? 'GMT+10:00';
    return new Date(
      `${target.toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}:00:00${tz.replace('GMT', '')}`,
    ).toISOString();
  };
  const now = new Date().toISOString();
  const make = (
    id: string,
    participantId: string,
    day: number,
    hour: number,
    duration: number,
    description: string,
    status: Shift['status'],
    staffId: string | null,
  ): Shift => ({
    id,
    participantId,
    start: at(day, hour),
    end: at(day, hour + duration),
    description,
    status,
    staffId,
    location: 'Newcastle, NSW',
    driving: 'required',
    gender: 'no_preference',
    notes: '',
    kind: 'general',
    source: 'staff',
    eventId: null,
    pendingChange: null,
    syncStatus: 'not_configured',
    createdAt: now,
    updatedAt: now,
  });
  const shifts: Shift[] = [
    make('shift-1', 'p-alex', 0, 9, 3, 'A little help with the everyday', 'confirmed', 's-emma'),
    make('shift-2', 'p-jamie', 0, 13, 3, 'Community access & shopping', 'confirmed', 's-james'),
    make('shift-3', 'p-morgan', 1, 10, 2, 'Coffee, catch-up & a walk', 'confirmed', 's-sophie'),
    make('shift-4', 'p-alex', 2, 9, 3, 'Cooking & meal preparation', 'confirmed', 's-emma'),
    make('shift-5', 'p-jordan', 2, 13, 3, 'Getting out in the community', 'confirmed', 's-liam'),
    make('shift-6', 'p-jamie', 3, 10, 3, 'Weekly shopping & errands', 'requested', null),
    make('shift-7', 'p-alex', 4, 9, 3, 'A trip to the farmers market', 'requested', null),
    make('shift-8', 'p-morgan', 4, 13, 2, 'Art supplies & creative time', 'confirmed', 's-sophie'),
    make('shift-9', 'p-jordan', 6, 10, 3, 'Sunday community outing', 'requested', null),
    make('shift-10', 'p-alex', 7, 9, 3, 'Everyday support at home', 'confirmed', 's-emma'),
    make('shift-11', 'p-jamie', 8, 11, 2, 'Library visit & lunch', 'confirmed', 's-james'),
  ];
  const events: SupportEvent[] = [
    {
      id: 'event-1',
      title: 'Friday social club',
      start: at(4, 17),
      end: at(4, 20),
      location: 'The Social Hub, Newcastle',
      description: 'Good food, familiar faces and a relaxed Friday evening.',
      rsvpCount: 0,
      supportCount: 0,
    },
    {
      id: 'event-2',
      title: 'Coastal walk & picnic',
      start: at(5, 10),
      end: at(5, 13),
      location: 'Nobbys Beach',
      description: 'A gentle coastal walk, followed by a picnic together.',
      rsvpCount: 0,
      supportCount: 0,
    },
    {
      id: 'event-3',
      title: 'Creative workshop',
      start: at(9, 14),
      end: at(9, 16),
      location: 'Community Arts Space',
      description: 'Make something you love in a friendly creative workshop.',
      rsvpCount: 0,
      supportCount: 0,
    },
  ];
  store.transaction(() => {
    for (const participant of participants) store.put('participants', participant);
    for (const member of staff) store.put('staff', member);
    for (const shift of shifts) store.put('shifts', shift);
    for (const event of events) store.put('events', event);
    upsertRsvp(store, events[0], participants[0], 'attending', false);
    upsertRsvp(store, events[0], participants[2], 'attending', false);
    upsertRsvp(store, events[1], participants[3], 'attending', false);
    upsertRsvp(store, events[1], participants[5], 'attending', false);
    const passwordHash = hashPassword('DemoSupport!2026');
    store.putUser({
      id: 'u-staff',
      name: 'Olivia Thompson',
      email: 'coordinator@mtm.demo',
      role: 'staff',
      participantIds: [],
      passwordHash,
    });
    store.putUser({
      id: 'u-client',
      name: 'Alex Morgan',
      email: 'alex@mtm.demo',
      role: 'client',
      participantIds: ['p-alex', 'p-jamie'],
      passwordHash,
    });
    store.setMeta('demoSeeded', 'true');
    store.setMeta('demoDatabase', 'true');
  });
}
