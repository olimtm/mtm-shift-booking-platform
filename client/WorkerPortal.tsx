import { useState } from 'react';
import { ArrowRight, CalendarDays, LogOut, RefreshCw } from 'lucide-react';
import type { DashboardData } from '../shared/types';
import { shiftTitle } from '../shared/views';
import Brand from './Brand';
import { fmt, time } from './dates';
import { Empty, ErrorNotice, Spinner } from './ui';
import { ShiftDetail } from './forms';
import { ShiftUpdateDialog } from './ShiftUpdates';

export default function WorkerPortal({
  data,
  refresh,
  onLogout,
  error,
}: {
  data: DashboardData;
  refresh: () => Promise<unknown>;
  onLogout: () => Promise<void>;
  error: string;
}) {
  const [tab, setTab] = useState<'upcoming' | 'missing' | 'completed'>('upcoming');
  const [selected, setSelected] = useState<string | null>(null);
  const [details, setDetails] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const now = Date.now();
  const updates = data.shiftUpdates ?? [];
  const missing = data.shifts.filter(
    (s) =>
      s.status === 'confirmed' &&
      Date.parse(s.end) <= now &&
      !updates.some((u) => u.shiftId === s.id),
  );
  const shifts = data.shifts
    .filter((s) =>
      tab === 'upcoming'
        ? s.status === 'confirmed' && Date.parse(s.end) > now
        : tab === 'missing'
          ? missing.some((m) => m.id === s.id)
          : Date.parse(s.end) <= now || s.status === 'cancelled',
    )
    .sort((a, b) =>
      tab === 'upcoming' ? a.start.localeCompare(b.start) : b.start.localeCompare(a.start),
    );
  const selectedShift = data.shifts.find((s) => s.id === selected);
  const detailShift = data.shifts.find((s) => s.id === details);
  return (
    <div className="worker-portal">
      <header className="worker-header">
        <Brand />
        <div>
          <span>{data.user.name}</span>
          <button className="secondary-button" onClick={() => void onLogout()}>
            <LogOut size={16} />
            Sign out
          </button>
        </div>
      </header>
      <main className="worker-main">
        <div className="page-heading">
          <h1>My shifts</h1>
          <button
            className="secondary-button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setRefreshError('');
              try {
                await refresh();
              } catch (e) {
                setRefreshError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Spinner /> : <RefreshCw size={16} />}Refresh
          </button>
        </div>
        {(error || refreshError) && <ErrorNotice>{refreshError || error}</ErrorNotice>}
        <div className="tab-buttons period-tabs" role="tablist" aria-label="My shifts">
          <button
            role="tab"
            className={tab === 'upcoming' ? 'active' : ''}
            aria-selected={tab === 'upcoming'}
            onClick={() => setTab('upcoming')}
          >
            Upcoming
          </button>
          <button
            role="tab"
            className={tab === 'missing' ? 'active' : ''}
            aria-selected={tab === 'missing'}
            onClick={() => setTab('missing')}
          >
            Updates to complete{missing.length ? ` (${missing.length})` : ''}
          </button>
          <button
            role="tab"
            className={tab === 'completed' ? 'active' : ''}
            aria-selected={tab === 'completed'}
            onClick={() => setTab('completed')}
          >
            Completed
          </button>
        </div>
        <div className="update-list">
          {shifts.map((shift) => {
            const update = updates.find((u) => u.shiftId === shift.id);
            const ended = Date.parse(shift.end) <= now;
            return (
              <article className="update-card" key={shift.id}>
                <span className="field-hint">
                  <CalendarDays size={15} />
                  {fmt(
                    shift.start,
                    { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' },
                    data.timezone,
                  )}{' '}
                  · {time(shift.start, data.timezone)}–{time(shift.end, data.timezone)}
                </span>
                <h2>{data.participants.find((p) => p.id === shift.participantId)?.name}</h2>
                <p>{shiftTitle(shift, data.events)}</p>
                <p className="field-hint">{shift.location || 'Meeting place to be arranged'}</p>
                {shift.status === 'cancelled' && (
                  <span className="status status-cancelled">Cancelled</span>
                )}
                <div className="inline-actions">
                  <button className="secondary-button" onClick={() => setDetails(shift.id)}>
                    Shift details
                  </button>
                  {(update || (ended && shift.status === 'confirmed')) && (
                    <button className="primary-button" onClick={() => setSelected(shift.id)}>
                      {update ? 'View update' : 'Write post-shift update'}
                      <ArrowRight size={16} />
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
        {!shifts.length && (
          <Empty
            title={
              tab === 'upcoming'
                ? 'No upcoming shifts assigned'
                : tab === 'missing'
                  ? 'You’re up to date'
                  : 'No completed shifts yet'
            }
          >
            {tab === 'missing'
              ? 'All completed shifts have a shared update.'
              : 'Your assigned shifts will appear here.'}
          </Empty>
        )}
      </main>
      <footer className="app-footer">MTM · Worker portal</footer>
      {selectedShift && (
        <ShiftUpdateDialog
          key={selectedShift.id}
          data={data}
          shift={selectedShift}
          onClose={() => setSelected(null)}
          onSaved={refresh}
        />
      )}
      {detailShift && (
        <ShiftDetail
          key={detailShift.id}
          data={data}
          shift={detailShift}
          onClose={() => setDetails(null)}
          onEdit={() => {}}
          onAction={async () => {}}
        />
      )}
    </div>
  );
}
