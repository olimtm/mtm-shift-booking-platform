import { useState, type FormEvent } from 'react';
import { ArrowRight, Check, ClipboardList, History, Plus, ShieldCheck, X } from 'lucide-react';
import type {
  DashboardData,
  GoalProgress,
  InternalShiftUpdate,
  SharedShiftUpdate,
  Shift,
  ShiftUpdate,
} from '../shared/types';
import { shiftTitle } from '../shared/views';
import { api } from './api';
import { fmt, time } from './dates';
import { Empty, ErrorNotice, Modal, Spinner } from './ui';

const progressLabels: Record<GoalProgress['progress'], string> = {
  practised: 'Practised',
  progress: 'Made progress',
  maintained: 'Maintained skills',
  needs_support: 'Needed more support',
};
const blankInternal: InternalShiftUpdate = {
  notes: '',
  followUpRequired: false,
  followUpNotes: '',
  incidentReference: '',
};
export function SharedUpdateBody({ update }: { update: SharedShiftUpdate }) {
  return (
    <div className="update-body">
      <section>
        <h3>What we did</h3>
        <p>{update.activities}</p>
      </section>
      <section>
        <h3>How it went</h3>
        <p>{update.howItWent}</p>
      </section>
      <section>
        <h3>Participant’s feedback</h3>
        <p>{update.feedbackProvided ? update.participantFeedback : 'No feedback provided.'}</p>
      </section>
      <section>
        <h3>Goal progress</h3>
        {update.noGoalWork ? (
          <p>{update.noGoalReason}</p>
        ) : (
          update.goals.map((goal, index) => (
            <div className="goal-result" key={index}>
              <strong>{goal.goal}</strong>
              <span>{progressLabels[goal.progress]}</span>
              <p>{goal.evidence}</p>
            </div>
          ))
        )}
      </section>
      {update.nextTime && (
        <section>
          <h3>For next time</h3>
          <p>{update.nextTime}</p>
        </section>
      )}
    </div>
  );
}
function InternalUpdateBody({ value }: { value: InternalShiftUpdate }) {
  if (!value.notes && !value.followUpRequired && !value.incidentReference) return null;
  return (
    <section className="update-internal">
      <h3>
        <ShieldCheck size={17} />
        Internal only
      </h3>
      {value.notes && <p>{value.notes}</p>}
      {value.followUpRequired && (
        <p>
          <strong>Coordinator follow-up needed: </strong>
          {value.followUpNotes}
        </p>
      )}
      {value.incidentReference && (
        <p>
          <strong>Incident reference: </strong>
          {value.incidentReference}
        </p>
      )}
    </section>
  );
}
export function PublishedUpdate({ update, timezone }: { update: ShiftUpdate; timezone: string }) {
  return (
    <article className="published-update">
      <p className="field-hint">
        Shared by {update.authorName} ·{' '}
        {fmt(
          update.publishedAt,
          { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' },
          timezone,
        )}
      </p>
      {update.version > 1 && (
        <p className="field-hint">
          Updated by {update.editedByName} · revision {update.version}
        </p>
      )}
      <SharedUpdateBody update={update} />
      {update.internal && <InternalUpdateBody value={update.internal} />}
    </article>
  );
}
export function ShiftUpdateDialog({
  data,
  shift,
  onClose,
  onSaved,
}: {
  data: DashboardData;
  shift: Shift;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const current = data.shiftUpdates?.find((update) => update.shiftId === shift.id);
  const [editing, setEditing] = useState(!current && data.user.role !== 'client');
  const [history, setHistory] = useState<ShiftUpdate[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const person = data.participants.find((p) => p.id === shift.participantId);
  const eligible = shift.status === 'confirmed' && Date.parse(shift.end) <= Date.now();
  return (
    <Modal
      title={editing ? (current ? 'Edit shift update' : 'Post-shift update') : 'Shift update'}
      subtitle={`${person?.name || 'Participant'} · ${fmt(shift.start, { day: 'numeric', month: 'long', year: 'numeric' }, data.timezone)} · ${time(shift.start, data.timezone)}–${time(shift.end, data.timezone)} · ${data.staff.find((worker) => worker.id === shift.staffId)?.name || shift.staffDisplayName || 'Unassigned'} · ${shiftTitle(shift, data.events)}`}
      onClose={onClose}
      wide
    >
      {editing ? (
        <ShiftUpdateForm current={current} onClose={onClose} onSaved={onSaved} shift={shift} />
      ) : (
        <div className="form-body">
          <h3>{shiftTitle(shift, data.events)}</h3>
          {current ? (
            <PublishedUpdate update={current} timezone={data.timezone} />
          ) : (
            <Empty title="No update shared yet">
              The post-shift update will appear here once submitted.
            </Empty>
          )}
          {error && <ErrorNotice>{error}</ErrorNotice>}
          {history && (
            <section className="update-history" aria-label="Revision history">
              <h3>Revision history</h3>
              {history.map((version) => (
                <details key={version.version}>
                  <summary>
                    Revision {version.version} · {version.editedByName} ·{' '}
                    {fmt(
                      version.updatedAt,
                      { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' },
                      data.timezone,
                    )}
                  </summary>
                  <PublishedUpdate update={version} timezone={data.timezone} />
                </details>
              ))}
            </section>
          )}
          <footer className="form-footer">
            {current && (
              <button
                className="secondary-button"
                disabled={loading}
                onClick={async () => {
                  setLoading(true);
                  setError('');
                  try {
                    setHistory(
                      (await api<{ versions: ShiftUpdate[] }>(`/shifts/${shift.id}/update/history`))
                        .versions,
                    );
                  } catch (error) {
                    setError((error as Error).message);
                  } finally {
                    setLoading(false);
                  }
                }}
              >
                {loading ? <Spinner /> : <History size={16} />}Revision history
              </button>
            )}
            {current?.canEdit && eligible && (
              <button className="primary-button" onClick={() => setEditing(true)}>
                Edit update
              </button>
            )}
            <button className="secondary-button" onClick={onClose}>
              Close
            </button>
          </footer>
        </div>
      )}
    </Modal>
  );
}
function ShiftUpdateForm({
  current,
  shift,
  onClose,
  onSaved,
}: {
  current?: ShiftUpdate;
  shift: Shift;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const [values, setValues] = useState<SharedShiftUpdate>(() => ({
    activities: current?.activities ?? '',
    howItWent: current?.howItWent ?? '',
    feedbackProvided: current?.feedbackProvided ?? false,
    participantFeedback: current?.participantFeedback ?? '',
    goals: current?.goals ?? [{ goal: '', progress: 'practised', evidence: '' }],
    noGoalWork: current?.noGoalWork ?? false,
    noGoalReason: current?.noGoalReason ?? '',
    nextTime: current?.nextTime ?? '',
  }));
  const [internal, setInternal] = useState(current?.internal ?? blankInternal);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  function change<K extends keyof SharedShiftUpdate>(key: K, value: SharedShiftUpdate[K]) {
    setValues((old) => ({ ...old, [key]: value }));
  }
  function goalChange(index: number, patch: Partial<GoalProgress>) {
    change(
      'goals',
      values.goals.map((goal, i) => (i === index ? { ...goal, ...patch } : goal)),
    );
  }
  function previewUpdate(event: FormEvent) {
    event.preventDefault();
    setError('');
    setPreview(true);
  }
  async function publish() {
    setBusy(true);
    setError('');
    try {
      await api(`/shifts/${shift.id}/update`, {
        method: 'PUT',
        body: JSON.stringify({ ...values, internal, version: current?.version ?? 0 }),
      });
      await onSaved();
      onClose();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (preview)
    return (
      <div className="form-body" aria-label="Shared update preview">
        <div className="info-notice">
          <Check size={18} />
          <span>
            Preview: visible to the participant and their authorised contacts immediately after
            submission.
          </span>
        </div>
        <SharedUpdateBody update={values} />
        <p className="field-hint">
          Internal notes are saved separately and are not included in this shared update.
        </p>
        {error && <ErrorNotice>{error}</ErrorNotice>}
        <footer className="form-footer">
          <button className="secondary-button" disabled={busy} onClick={() => setPreview(false)}>
            Back to form
          </button>
          <button className="primary-button" disabled={busy} onClick={publish}>
            {busy ? <Spinner /> : <Check size={16} />}
            {current ? 'Save & share changes' : 'Submit & share update'}
          </button>
        </footer>
      </div>
    );
  return (
    <form className="form-body shift-update-form" onSubmit={previewUpdate}>
      <div className="info-notice">
        <ClipboardList size={18} />
        <span>Shared with the participant and their authorised contacts.</span>
      </div>
      <label>
        What did we do?
        <textarea
          rows={3}
          required
          minLength={3}
          maxLength={3000}
          value={values.activities}
          onChange={(e) => change('activities', e.target.value)}
          placeholder="Activities and support provided"
        />
      </label>
      <label>
        How did it go?
        <textarea
          rows={3}
          required
          minLength={3}
          maxLength={3000}
          value={values.howItWent}
          onChange={(e) => change('howItWent', e.target.value)}
          placeholder="What went well, any difficulties, and adjustments that helped"
        />
      </label>
      <label className="update-check">
        <input
          type="checkbox"
          checked={values.feedbackProvided}
          onChange={(e) =>
            setValues((old) => ({
              ...old,
              feedbackProvided: e.target.checked,
              participantFeedback: e.target.checked ? old.participantFeedback : '',
            }))
          }
        />
        The participant provided feedback
      </label>
      {values.feedbackProvided ? (
        <label>
          Participant’s feedback
          <textarea
            rows={2}
            required
            maxLength={2000}
            value={values.participantFeedback}
            onChange={(e) => change('participantFeedback', e.target.value)}
            placeholder="What they said or communicated, in their own words where possible"
          />
        </label>
      ) : (
        <p className="field-hint">The shared update will say “No feedback provided.”</p>
      )}
      <fieldset className="update-goals">
        <legend>Goal progress</legend>
        <p className="field-hint">
          Record the participant’s goals or skills practised and a concrete example.
        </p>
        <label className="update-check">
          <input
            type="checkbox"
            checked={values.noGoalWork}
            onChange={(e) =>
              setValues((old) => ({
                ...old,
                noGoalWork: e.target.checked,
                noGoalReason: '',
                goals: e.target.checked ? [] : [{ goal: '', progress: 'practised', evidence: '' }],
              }))
            }
          />
          Goals were not worked on this shift
        </label>
        {values.noGoalWork ? (
          <label>
            Why were goals not worked on?
            <textarea
              rows={2}
              minLength={3}
              required
              maxLength={1500}
              value={values.noGoalReason}
              onChange={(e) => change('noGoalReason', e.target.value)}
            />
          </label>
        ) : (
          <>
            {values.goals.map((goal, index) => (
              <div className="goal-entry" key={index}>
                <label>
                  Goal or skill {index + 1}
                  <input
                    required
                    minLength={2}
                    maxLength={200}
                    value={goal.goal}
                    onChange={(e) => goalChange(index, { goal: e.target.value })}
                    placeholder="For example, ordering lunch independently"
                  />
                </label>
                <label>
                  Progress {index + 1}
                  <select
                    value={goal.progress}
                    onChange={(e) =>
                      goalChange(index, { progress: e.target.value as GoalProgress['progress'] })
                    }
                  >
                    {Object.entries(progressLabels).map(([value, label]) => (
                      <option value={value} key={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Example from this shift {index + 1}
                  <textarea
                    rows={2}
                    required
                    minLength={3}
                    maxLength={1500}
                    value={goal.evidence}
                    onChange={(e) => goalChange(index, { evidence: e.target.value })}
                    placeholder="What happened and what support was needed?"
                  />
                </label>
                {values.goals.length > 1 && (
                  <button
                    type="button"
                    className="text-link"
                    onClick={() =>
                      change(
                        'goals',
                        values.goals.filter((_, i) => i !== index),
                      )
                    }
                  >
                    <X size={15} />
                    Remove goal {index + 1}
                  </button>
                )}
              </div>
            ))}
            {values.goals.length < 8 && (
              <button
                type="button"
                className="secondary-button"
                onClick={() =>
                  change('goals', [
                    ...values.goals,
                    { goal: '', progress: 'practised', evidence: '' },
                  ])
                }
              >
                <Plus size={15} />
                Add another goal
              </button>
            )}
          </>
        )}
      </fieldset>
      <label>
        For next time <span className="field-hint">Optional</span>
        <textarea
          rows={2}
          maxLength={2000}
          value={values.nextTime}
          onChange={(e) => change('nextTime', e.target.value)}
        />
      </label>
      <fieldset className="update-internal">
        <legend>Internal only — not shared with participants or contacts</legend>
        <label>
          Internal handover notes
          <textarea
            rows={2}
            maxLength={3000}
            value={internal.notes}
            onChange={(e) => setInternal((old) => ({ ...old, notes: e.target.value }))}
          />
        </label>
        <label className="update-check">
          <input
            type="checkbox"
            checked={internal.followUpRequired}
            onChange={(e) =>
              setInternal((old) => ({
                ...old,
                followUpRequired: e.target.checked,
                followUpNotes: e.target.checked ? old.followUpNotes : '',
              }))
            }
          />
          Coordinator follow-up needed
        </label>
        {internal.followUpRequired && (
          <label>
            Follow-up needed
            <textarea
              rows={2}
              minLength={3}
              required
              maxLength={2000}
              value={internal.followUpNotes}
              onChange={(e) => setInternal((old) => ({ ...old, followUpNotes: e.target.value }))}
            />
          </label>
        )}
        <label>
          Incident report reference{' '}
          <span className="field-hint">Optional; use your usual incident reporting process</span>
          <input
            maxLength={200}
            value={internal.incidentReference}
            onChange={(e) => setInternal((old) => ({ ...old, incidentReference: e.target.value }))}
          />
        </label>
      </fieldset>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      <footer className="form-footer">
        <button type="button" className="secondary-button" onClick={onClose}>
          Cancel
        </button>
        <button className="primary-button">
          Preview shared update
          <ArrowRight size={16} />
        </button>
      </footer>
    </form>
  );
}

export default function ShiftUpdatesPage({
  data,
  onSaved,
}: {
  data: DashboardData;
  onSaved: () => Promise<unknown>;
}) {
  const [filter, setFilter] = useState<'shared' | 'missing' | 'followup'>('shared');
  const [participantId, setParticipantId] = useState('all');
  const [selected, setSelected] = useState<string | null>(null);
  const updates = data.shiftUpdates ?? [];
  const shifts = data.shifts
    .filter((shift) => {
      if (participantId !== 'all' && shift.participantId !== participantId) return false;
      const update = updates.find((u) => u.shiftId === shift.id);
      return filter === 'shared'
        ? Boolean(update)
        : filter === 'followup'
          ? update?.internal?.followUpRequired
          : !update && shift.status === 'confirmed' && Date.parse(shift.end) <= Date.now();
    })
    .sort((a, b) => b.start.localeCompare(a.start));
  const selectedShift = data.shifts.find((s) => s.id === selected);
  return (
    <section className="shift-updates-page">
      {data.user.role === 'staff' && (
        <div className="tab-buttons period-tabs" role="tablist" aria-label="Shift update view">
          {(
            [
              ['shared', 'Shared updates'],
              ['missing', 'Awaiting update'],
              ['followup', 'Follow-up needed'],
            ] as const
          ).map(([value, label]) => (
            <button
              role="tab"
              className={filter === value ? 'active' : ''}
              aria-selected={filter === value}
              key={value}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <label className="update-participant-filter">
        Participant
        <select value={participantId} onChange={(e) => setParticipantId(e.target.value)}>
          <option value="all">All linked participants</option>
          {data.participants.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <div className="update-list">
        {shifts.map((shift) => {
          const update = updates.find((u) => u.shiftId === shift.id);
          return (
            <button className="update-card" key={shift.id} onClick={() => setSelected(shift.id)}>
              <span className="field-hint">
                {fmt(
                  shift.start,
                  { day: 'numeric', month: 'short', year: 'numeric' },
                  data.timezone,
                )}{' '}
                · {time(shift.start, data.timezone)}–{time(shift.end, data.timezone)}
              </span>
              <strong>{data.participants.find((p) => p.id === shift.participantId)?.name}</strong>
              <span>{shiftTitle(shift, data.events)}</span>
              {update && (
                <p>
                  {update.activities.slice(0, 180)}
                  {update.activities.length > 180 ? '…' : ''}
                </p>
              )}
              <span className="text-link">
                {update ? 'Read update' : 'Write update'} <ArrowRight size={16} />
              </span>
            </button>
          );
        })}
      </div>
      {!shifts.length && (
        <Empty
          title={
            filter === 'shared'
              ? 'No shift updates yet'
              : filter === 'missing'
                ? 'All completed shifts have an update'
                : 'No follow-up flagged'
          }
        >
          Shared updates include activities, participant feedback and goal progress.
        </Empty>
      )}
      {selectedShift && (
        <ShiftUpdateDialog
          key={selectedShift.id}
          data={data}
          shift={selectedShift}
          onSaved={onSaved}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}
