import { shiftTitle, isActiveParticipant, isActiveWorker } from '../shared/views';
import { LOCATION_MAX_LENGTH } from '../shared/limits.js';
import { useState, type FormEvent } from 'react';
import {
  CalendarDays,
  Clock3,
  MapPin,
  Car,
  UserRound,
  Info,
  Check,
  X,
  ArrowRight,
  AlertCircle,
} from 'lucide-react';
import type {
  DashboardData,
  Participant,
  Shift,
  ShiftInput,
  SupportEvent,
  SupportType,
} from '../shared/types';
import { dayKey, duration, fmt, hoursLabel, inputDate, time, zonedIso } from './dates';
import { Avatar, ErrorNotice, Modal, Spinner, Status, supportLabels } from './ui';

interface FormProps {
  data: DashboardData;
  onClose: () => void;
  onSave: (values: ShiftInput) => Promise<void>;
  existing?: Shift;
  initialDay?: string;
  initialParticipant?: string;
}
export function ShiftForm({
  data,
  onClose,
  onSave,
  existing,
  initialDay,
  initialParticipant,
}: FormProps) {
  const today = initialDay || dayKey(new Date(), data.timezone);
  const [values, setValues] = useState({
    participantId:
      existing?.participantId ||
      initialParticipant ||
      data.participants.find(isActiveParticipant)?.id ||
      '',
    start: existing ? inputDate(existing.start, data.timezone) : `${today}T09:00`,
    end: existing ? inputDate(existing.end, data.timezone) : `${today}T12:00`,
    description: existing?.description || '',
    location: existing?.location || '',
    driving: existing?.driving || 'no_preference',
    gender: existing?.gender || 'no_preference',
    notes: existing?.notes || '',
    kind: existing?.kind || 'general',
    eventId: existing?.eventId || '',
  } satisfies Omit<ShiftInput, 'start' | 'end'> & { start: string; end: string });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  function change(key: keyof typeof values, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const start = zonedIso(values.start, data.timezone);
      const end = zonedIso(values.end, data.timezone);
      if (new Date(end) <= new Date(start))
        throw new Error('The end time must be after the start time.');
      await onSave({
        ...values,
        start,
        end,
        eventId: values.kind === 'event' ? values.eventId || null : null,
      });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={existing ? 'Request a shift change' : 'Request support'}
      subtitle={
        existing
          ? 'Your existing booking stays in place while the change is reviewed.'
          : 'Requests require coordinator approval.'
      }
      onClose={busy ? () => {} : onClose}
      wide
    >
      <form onSubmit={submit} className="form-body">
        <label>
          Participant <span className="required">*</span>
          <select
            value={values.participantId}
            onChange={(e) => change('participantId', e.target.value)}
            required
            disabled={!!existing}
          >
            {data.participants
              .filter((p) => p.id === existing?.participantId || isActiveParticipant(p))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.supportType === 'none' ? ' · No regular support' : ''}
                </option>
              ))}
          </select>
        </label>
        {data.participants.find((p) => p.id === values.participantId)?.supportType === 'none' && (
          <div className="info-notice">
            <Info size={16} />
            This participant has no regular support. You can still request a one-off shift.
          </div>
        )}
        <div className="form-row">
          <label>
            Starts <span className="required">*</span>
            <input
              type="datetime-local"
              value={values.start}
              onChange={(e) => change('start', e.target.value)}
              required
            />
          </label>
          <label>
            Ends <span className="required">*</span>
            <input
              type="datetime-local"
              value={values.end}
              onChange={(e) => change('end', e.target.value)}
              required
            />
          </label>
        </div>
        <p className="field-hint">
          All times are in {data.timezone.replace('_', ' ')}. Overnight shifts can use the following
          date.
        </p>
        <label>
          What would you like support with? <span className="required">*</span>
          <input
            value={values.description}
            onChange={(e) => change('description', e.target.value)}
            placeholder="e.g. A trip to the shops and lunch together"
            minLength={3}
            maxLength={3000}
            required
          />
        </label>
        <div className="form-row">
          <label>
            Support type
            <select
              value={values.kind}
              disabled={!!existing?.eventId}
              onChange={(e) => change('kind', e.target.value)}
            >
              <option value="general">General support</option>
              <option value="event">Event support</option>
            </select>
          </label>
          <label>
            Meeting place
            <input
              value={values.location}
              onChange={(e) => change('location', e.target.value)}
              placeholder="Address or meeting point"
              maxLength={LOCATION_MAX_LENGTH}
            />
          </label>
        </div>
        {values.kind === 'event' && (
          <label>
            Event
            <select
              value={values.eventId}
              disabled={!!existing}
              required={!existing}
              onChange={(e) => {
                const event = data.events.find((event) => event.id === e.target.value);
                setValues((current) => ({
                  ...current,
                  eventId: e.target.value,
                  ...(event
                    ? {
                        description: `Support for ${event.title}`,
                        start: inputDate(
                          new Date(Date.parse(event.start) - 30 * 60_000).toISOString(),
                          data.timezone,
                        ),
                        end: inputDate(
                          new Date(Date.parse(event.end) + 30 * 60_000).toISOString(),
                          data.timezone,
                        ),
                        location: event.location,
                      }
                    : {}),
                }));
              }}
            >
              <option value="">{existing ? 'Event not linked' : 'Select an event'}</option>
              {data.events
                .filter(
                  (event) => event.id === existing?.eventId || Date.parse(event.end) > Date.now(),
                )
                .map((event) => (
                  <option key={event.id} value={event.id}>
                    {event.title} ·{' '}
                    {fmt(
                      event.start,
                      { day: 'numeric', month: 'short', year: 'numeric' },
                      data.timezone,
                    )}
                  </option>
                ))}
            </select>
          </label>
        )}
        <div className="form-section-heading">
          <span>Worker preferences</span>
          <span>Preferences, not guarantees</span>
        </div>
        <div className="form-row">
          <label>
            Driving preference
            <select value={values.driving} onChange={(e) => change('driving', e.target.value)}>
              <option value="no_preference">No preference</option>
              <option value="required">A driving support worker</option>
              <option value="not_required">A non-driving support worker</option>
            </select>
          </label>
          <label>
            Support worker preference
            <select value={values.gender} onChange={(e) => change('gender', e.target.value)}>
              <option value="no_preference">No preference</option>
              <option value="female">Female support worker</option>
              <option value="male">Male support worker</option>
            </select>
          </label>
        </div>
        <label>
          Anything else we should know?
          <textarea
            rows={3}
            value={values.notes}
            onChange={(e) => change('notes', e.target.value)}
            placeholder="Your preferences or useful details for this shift"
            maxLength={2000}
          />
        </label>
        <div className="info-notice">
          <Clock3 size={17} />
          <span>
            {existing
              ? 'A coordinator will review this change before updating the booking.'
              : 'Requests are reviewed by a coordinator before your shift is confirmed.'}
          </span>
        </div>
        {error && <ErrorNotice>{error}</ErrorNotice>}
        <footer className="form-footer">
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary-button" disabled={busy || !data.participants.length}>
            {busy ? <Spinner /> : <ArrowRight size={16} />}
            {existing ? 'Send change request' : 'Send support request'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function ShiftDetail({
  data,
  shift,
  onClose,
  onEdit,
  onAction,
}: {
  data: DashboardData;
  shift: Shift;
  onClose: () => void;
  onEdit: () => void;
  onAction: (action: string, extras?: Record<string, unknown>) => Promise<void>;
}) {
  const participant = data.participants.find((p) => p.id === shift.participantId);
  const worker = data.staff.find((p) => p.id === shift.staffId);
  const [staffId, setStaffId] = useState(shift.staffId || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const staff = data.user.role === 'staff';
  const active = shift.status === 'requested' || shift.status === 'confirmed';
  async function act(action: string, extras: Record<string, unknown> = {}) {
    setError('');
    setBusy(true);
    try {
      await onAction(action, extras);
      setCancelling(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Shift details" subtitle="" onClose={busy ? () => {} : onClose}>
      <div className="detail-body">
        <div className="detail-person">
          <Avatar name={participant?.name || 'Participant'} color={participant?.color} />
          <div>
            <h3>{participant?.name}</h3>
            <span>{shift.kind === 'event' ? 'Event support' : 'General support'}</span>
          </div>
          <Status shift={shift} />
        </div>
        <h2 className="detail-description">{shiftTitle(shift, data.events)}</h2>
        {shift.eventId &&
          shift.description &&
          shift.description !== shiftTitle(shift, data.events) && <p>{shift.description}</p>}
        <div className="detail-facts">
          <p>
            <CalendarDays size={18} />
            <span>
              {fmt(
                shift.start,
                { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' },
                data.timezone,
              )}
            </span>
          </p>
          <p>
            <Clock3 size={18} />
            <span>
              {time(shift.start, data.timezone)} – {time(shift.end, data.timezone)}
              {dayKey(shift.start, data.timezone) !== dayKey(shift.end, data.timezone) &&
                ` (${fmt(shift.end, { day: 'numeric', month: 'short' }, data.timezone)})`}
              <small>
                {hoursLabel(duration(shift.start, shift.end))} · {data.timezone}
              </small>
            </span>
          </p>
          <p>
            <MapPin size={18} />
            <span>{shift.location || 'Meeting place to be arranged'}</span>
          </p>
          <p>
            <UserRound size={18} />
            <span>{worker?.name || shift.staffDisplayName || 'Support worker to be assigned'}</span>
          </p>
        </div>
        <div className="preference-grid">
          <div>
            <Car size={17} />
            <span>
              Driving preference
              <strong>
                {shift.driving === 'required'
                  ? 'Driving worker'
                  : shift.driving === 'not_required'
                    ? 'Non-driving worker'
                    : 'No preference'}
              </strong>
            </span>
          </div>
          <div>
            <UserRound size={17} />
            <span>
              Worker preference
              <strong>
                {shift.gender === 'no_preference'
                  ? 'No preference'
                  : `${shift.gender === 'female' ? 'Female' : 'Male'} worker`}
              </strong>
            </span>
          </div>
        </div>
        {shift.notes && (
          <div className="detail-notes">
            <h4>Shift notes</h4>
            <p>{shift.notes}</p>
          </div>
        )}
        {shift.source === 'event' && (
          <div className="info-notice">
            <Info size={17} />
            <span>Created from an event RSVP. Includes 30 minutes before and after the event.</span>
          </div>
        )}
        {shift.pendingChange && (
          <div className="pending-change">
            <h4>
              <Clock3 size={16} />
              {shift.pendingChange.type === 'cancel'
                ? 'Cancellation requested'
                : 'Change awaiting approval'}
            </h4>
            {shift.pendingChange.type === 'cancel' ? (
              <p>
                {shift.pendingChange.reason || 'This shift has been requested for cancellation.'}
              </p>
            ) : (
              <>
                <p>
                  <strong>{shift.pendingChange.values?.description}</strong>
                </p>
                <p>
                  {shift.pendingChange.values &&
                    `${fmt(shift.pendingChange.values.start, { day: 'numeric', month: 'short' }, data.timezone)} · ${time(shift.pendingChange.values.start, data.timezone)} – ${time(shift.pendingChange.values.end, data.timezone)}`}
                </p>
                {shift.pendingChange.values?.location && (
                  <p>{shift.pendingChange.values.location}</p>
                )}
                {shift.pendingChange.values && (
                  <p>
                    Driving: {shift.pendingChange.values.driving.replaceAll('_', ' ')} · Worker:{' '}
                    {shift.pendingChange.values.gender.replaceAll('_', ' ')}
                  </p>
                )}
                {shift.pendingChange.values?.notes && <p>{shift.pendingChange.values.notes}</p>}
              </>
            )}
            <small>The current shift stays in place until a coordinator approves.</small>
            {staff && (
              <div className="inline-actions">
                <button
                  className="primary-button"
                  disabled={busy}
                  onClick={() => act('approve_change')}
                >
                  <Check size={15} />
                  Approve change
                </button>
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => act('reject_change')}
                >
                  <X size={15} />
                  Keep original
                </button>
              </div>
            )}
          </div>
        )}
        {staff && shift.staffDisplayName && !shift.staffId && (
          <div className="info-notice">
            <Info size={17} />
            <span>
              This worker name came from Airtable. Link an identifiable worker below to check
              availability and manage their assignment.
            </span>
          </div>
        )}
        {staff && active && (
          <label>
            Assigned support worker
            <select value={staffId} onChange={(e) => setStaffId(e.target.value)}>
              <option value="">Not assigned yet</option>
              {worker && !isActiveWorker(worker) && (
                <option value={worker.id} disabled>
                  {worker.name} (inactive)
                </option>
              )}
              {data.staff.filter(isActiveWorker).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            {worker && !isActiveWorker(worker) && (
              <span className="field-hint">
                This worker is no longer active. The booking is unchanged; select an active worker
                to reassign it.
              </span>
            )}
            {shift.status === 'confirmed' &&
              (staffId !== (shift.staffId || '') || !!shift.staffDisplayName) && (
                <button
                  className="text-link"
                  disabled={busy}
                  onClick={() => act('assign', { staffId: staffId || null })}
                >
                  Save assignment <ArrowRight size={15} />
                </button>
              )}
          </label>
        )}
        {staff && (
          <div className="sync-caption">
            <span
              className={`connection-dot ${shift.syncStatus === 'synced' ? 'connected' : ''}`}
            />
            {
              {
                not_configured: 'Saved in portal · Airtable not connected',
                pending: 'Saved in portal · Airtable sync pending',
                synced: 'Synced to Airtable',
                failed: 'Saved in portal · Airtable sync needs attention',
              }[shift.syncStatus]
            }
          </div>
        )}
        {cancelling && (
          <div className="cancel-form">
            <label>
              Reason for cancellation
              <textarea
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Let the team know why"
                maxLength={1000}
              />
            </label>
            <div className="inline-actions">
              <button
                className="danger-button"
                disabled={busy}
                onClick={() => act('cancel', { reason })}
              >
                {staff ? 'Cancel shift' : 'Request cancellation'}
              </button>
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => setCancelling(false)}
              >
                Keep shift
              </button>
            </div>
          </div>
        )}
        {error && <ErrorNotice>{error}</ErrorNotice>}
        <footer className="detail-footer">
          {staff && shift.status === 'requested' ? (
            <>
              <button className="secondary-button" disabled={busy} onClick={() => act('decline')}>
                Decline request
              </button>
              <button
                className="primary-button"
                disabled={busy}
                onClick={() => act('approve', { staffId: staffId || null })}
              >
                {busy ? <Spinner /> : <Check size={16} />}Approve shift
              </button>
            </>
          ) : (
            <>
              <button className="secondary-button" onClick={onClose} disabled={busy}>
                Close
              </button>
              {active && !shift.pendingChange && (
                <button className="primary-button" disabled={busy} onClick={onEdit}>
                  Request a change
                  <ArrowRight size={15} />
                </button>
              )}
            </>
          )}
        </footer>
        {active && !shift.pendingChange && !cancelling && (
          <button className="cancel-link" disabled={busy} onClick={() => setCancelling(true)}>
            {staff ? 'Cancel this shift' : 'Request a cancellation'}
          </button>
        )}
      </div>
    </Modal>
  );
}

export function ParticipantForm({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (values: { name: string; supportType: SupportType; notes: string }) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [supportType, setSupportType] = useState<SupportType>('general');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSave({ name, supportType, notes });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Add a participant" subtitle="" onClose={busy ? () => {} : onClose}>
      <form className="form-body" onSubmit={submit}>
        <label>
          Full name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={150} required />
        </label>
        <label>
          Support setting
          <select
            value={supportType}
            onChange={(e) => setSupportType(e.target.value as SupportType)}
          >
            {Object.entries(supportLabels).map(([key, label]) => (
              <option value={key} key={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Coordinator notes
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            maxLength={2000}
          />
        </label>
        <div className="info-notice">
          <Info size={16} />
          Portal access is granted separately by linking a client account to this participant.
        </div>
        {error && <ErrorNotice>{error}</ErrorNotice>}
        <footer className="form-footer">
          <button className="secondary-button" type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" disabled={busy}>
            {busy && <Spinner />}Add participant
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function EventForm({
  data,
  onClose,
  onSave,
}: {
  data: DashboardData;
  onClose: () => void;
  onSave: (values: Omit<SupportEvent, 'id' | 'rsvpCount' | 'supportCount'>) => Promise<void>;
}) {
  const day = dayKey(new Date(), data.timezone);
  const [values, setValues] = useState({
    title: '',
    start: `${day}T10:00`,
    end: `${day}T14:00`,
    location: '',
    description: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const start = zonedIso(values.start, data.timezone);
      const end = zonedIso(values.end, data.timezone);
      if (new Date(end) <= new Date(start)) throw new Error('End time must be after start time.');
      await onSave({
        ...values,
        start,
        end,
      });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Plan an event"
      subtitle="Eligible RSVPs include 30 minutes before and after the event."
      onClose={busy ? () => {} : onClose}
    >
      <form className="form-body" onSubmit={submit}>
        <label>
          Event name
          <input
            value={values.title}
            onChange={(e) => setValues({ ...values, title: e.target.value })}
            required
            minLength={2}
            maxLength={200}
          />
        </label>
        <div className="form-row">
          <label>
            Starts
            <input
              type="datetime-local"
              value={values.start}
              onChange={(e) => setValues({ ...values, start: e.target.value })}
              required
            />
          </label>
          <label>
            Ends
            <input
              type="datetime-local"
              value={values.end}
              onChange={(e) => setValues({ ...values, end: e.target.value })}
              required
            />
          </label>
        </div>
        <p className="field-hint">
          Times in {data.timezone}. Support requests include 30 minutes on either side.
        </p>
        <label>
          Location
          <input
            value={values.location}
            onChange={(e) => setValues({ ...values, location: e.target.value })}
            maxLength={LOCATION_MAX_LENGTH}
          />
        </label>
        <label>
          Description
          <textarea
            value={values.description}
            onChange={(e) => setValues({ ...values, description: e.target.value })}
            maxLength={2000}
          />
        </label>
        {error && <ErrorNotice>{error}</ErrorNotice>}
        <footer className="form-footer">
          <button className="secondary-button" type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" disabled={busy}>
            {busy && <Spinner />}Create event
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function EventDetail({
  event,
  data,
  onClose,
  onRsvp,
}: {
  event: SupportEvent;
  data: DashboardData;
  onClose: () => void;
  onRsvp: (participantId: string, status: 'attending' | 'cancelled') => Promise<void>;
}) {
  const [participantId, setParticipantId] = useState(
    data.participants.find(isActiveParticipant)?.id || '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const rsvps = data.rsvps.filter((r) => r.eventId === event.id && r.status === 'attending');
  async function update(id: string, status: 'attending' | 'cancelled') {
    setBusy(true);
    setError('');
    try {
      await onRsvp(id, status);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={event.title}
      subtitle={fmt(event.start, { weekday: 'long', day: 'numeric', month: 'long' }, data.timezone)}
      onClose={busy ? () => {} : onClose}
    >
      <div className="detail-body">
        <div className="detail-facts">
          <p>
            <Clock3 size={18} />
            {time(event.start, data.timezone)} – {time(event.end, data.timezone)} · {data.timezone}
          </p>
          <p>
            <MapPin size={18} />
            {event.location || 'To be arranged'}
          </p>
        </div>
        <p className="event-description">{event.description}</p>
        <div className="info-notice">
          <Info size={17} />
          <span>
            Participants set to event support or both receive a request for{' '}
            {time(new Date(new Date(event.start).getTime() - 1800000).toISOString(), data.timezone)}{' '}
            – {time(new Date(new Date(event.end).getTime() + 1800000).toISOString(), data.timezone)}{' '}
            when they RSVP.
          </span>
        </div>
        <h4 className="section-label">Attending · {rsvps.length}</h4>
        <div className="attendee-list">
          {rsvps.length ? (
            rsvps.map((r) => {
              const p = data.participants.find((p) => p.id === r.participantId);
              return (
                <div key={r.id}>
                  <Avatar name={p?.name || 'Participant'} color={p?.color} small />
                  <span>
                    <strong>{p?.name}</strong>
                    <small>
                      {r.shiftId ? 'Support request linked' : 'No automatic support request'}
                    </small>
                  </span>
                  {data.user.role === 'staff' && (
                    <button
                      className="text-link danger-text"
                      disabled={busy}
                      onClick={() => update(r.participantId, 'cancelled')}
                    >
                      Cancel RSVP
                    </button>
                  )}
                </div>
              );
            })
          ) : (
            <p className="muted">No RSVPs yet.</p>
          )}
        </div>
        {data.user.role === 'staff' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void update(participantId, 'attending');
            }}
            className="rsvp-form"
          >
            <label>
              Add an RSVP
              <select
                value={participantId}
                onChange={(e) => setParticipantId(e.target.value)}
                required
              >
                {data.participants.filter(isActiveParticipant).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {supportLabels[p.supportType]}
                  </option>
                ))}
              </select>
            </label>
            <button className="primary-button" disabled={busy || !participantId}>
              {busy ? <Spinner /> : <Check size={16} />}Record RSVP
            </button>
          </form>
        )}
        {error && <ErrorNotice>{error}</ErrorNotice>}
        <footer className="form-footer">
          <button className="secondary-button" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </Modal>
  );
}
