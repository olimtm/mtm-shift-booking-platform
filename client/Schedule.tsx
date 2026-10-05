import { useMemo } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, List, MapPin, Plus, Clock3 } from 'lucide-react';
import type { DashboardData, Shift } from '../shared/types';
import { addDays, dateLabel, dayKey, time, minutes, duration, hoursLabel } from './dates';
import { Avatar, Empty, Status } from './ui';

interface Props {
  data: DashboardData;
  shifts: Shift[];
  week: string;
  onWeek: (week: string) => void;
  view: 'week' | 'list';
  onView: (view: 'week' | 'list') => void;
  onSelect: (shift: Shift) => void;
  onNew: (date?: string) => void;
}
export function ShiftList({
  shifts,
  data,
  onSelect,
  showDate = true,
}: {
  shifts: Shift[];
  data: DashboardData;
  onSelect: (shift: Shift) => void;
  showDate?: boolean;
}) {
  if (!shifts.length)
    return (
      <Empty title="Nothing on the calendar just yet">
        New requests and planned support will appear here.
      </Empty>
    );
  return (
    <div className="shift-list">
      {shifts.map((shift) => {
        const participant = data.participants.find((p) => p.id === shift.participantId);
        const worker = data.staff.find((s) => s.id === shift.staffId);
        return (
          <button key={shift.id} className="shift-list-row" onClick={() => onSelect(shift)}>
            {showDate && (
              <div className="date-square">
                <span>{dateLabel(dayKey(shift.start, data.timezone), { month: 'short' })}</span>
                <strong>{dateLabel(dayKey(shift.start, data.timezone), { day: 'numeric' })}</strong>
              </div>
            )}
            <div className="shift-list-main">
              <div className="shift-title-line">
                <strong>{shift.description}</strong>
                {shift.kind === 'event' && <span className="event-label">Event</span>}
              </div>
              <span>
                {participant?.name}
                <span className="dot-separator">·</span>
                {time(shift.start, data.timezone)} – {time(shift.end, data.timezone)}
                <span className="dot-separator">·</span>
                {hoursLabel(duration(shift.start, shift.end))}
              </span>
            </div>
            <div className="shift-list-worker">
              <Avatar
                name={worker?.name || shift.staffDisplayName || 'Unassigned'}
                color={worker?.color || 'stone'}
                small
              />
              <span>{worker?.name || shift.staffDisplayName || 'Unassigned'}</span>
            </div>
            <Status shift={shift} />
            <ChevronRight size={17} className="row-chevron" />
          </button>
        );
      })}
    </div>
  );
}

export default function Schedule({
  data,
  shifts,
  week,
  onWeek,
  view,
  onView,
  onSelect,
  onNew,
}: Props) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const today = dayKey(new Date(), data.timezone);
  const visible = shifts.filter(
    (s) =>
      s.status !== 'cancelled' &&
      s.status !== 'declined' &&
      dayKey(s.start, data.timezone) <= days[6] &&
      (dayKey(s.end, data.timezone) > week ||
        (dayKey(s.end, data.timezone) === week && minutes(s.end, data.timezone) > 0)),
  );
  const sameMonth = week.slice(0, 7) === days[6].slice(0, 7);
  const dateRange = `${dateLabel(week, { day: 'numeric', ...(sameMonth ? {} : { month: 'short' as const }), ...(week.slice(0, 4) === days[6].slice(0, 4) ? {} : { year: 'numeric' as const }) })} – ${dateLabel(days[6], { day: 'numeric', month: 'short', year: 'numeric' })}`;
  const minHour = Math.min(
    8,
    ...visible.map((s) =>
      dayKey(s.start, data.timezone) !== dayKey(s.end, data.timezone)
        ? 0
        : Math.floor(minutes(s.start, data.timezone) / 60),
    ),
  );
  const maxHour = Math.max(
    19,
    ...visible.map((s) =>
      dayKey(s.end, data.timezone) !== dayKey(s.start, data.timezone)
        ? 24
        : Math.ceil(minutes(s.end, data.timezone) / 60),
    ),
  );
  const hourHeight = 67;
  const columns = useMemo(
    () =>
      days.map((day) => {
        const dayShifts = visible
          .filter(
            (s) => dayKey(s.start, data.timezone) <= day && dayKey(s.end, data.timezone) >= day,
          )
          .map((s) => ({
            shift: s,
            start: dayKey(s.start, data.timezone) < day ? 0 : minutes(s.start, data.timezone),
            end: dayKey(s.end, data.timezone) > day ? 1440 : minutes(s.end, data.timezone),
            lane: 0,
            lanes: 1,
          }))
          .filter((s) => s.end > s.start)
          .sort((a, b) => a.start - b.start || b.end - a.end);
        let group: typeof dayShifts = [];
        let groupEnd = -1;
        function finish() {
          const count = Math.max(1, ...group.map((s) => s.lane + 1));
          group.forEach((s) => {
            s.lanes = count;
          });
          group = [];
        }
        dayShifts.forEach((item) => {
          if (item.start >= groupEnd) finish();
          const occupied = new Set(group.filter((s) => s.end > item.start).map((s) => s.lane));
          while (occupied.has(item.lane)) item.lane++;
          group.push(item);
          groupEnd = Math.max(...group.map((s) => s.end));
        });
        finish();
        return dayShifts;
      }),
    [shifts, week, data.timezone],
  );
  return (
    <section className="calendar-panel">
      <div className="calendar-toolbar">
        <div className="calendar-period">
          <div className="calendar-nav">
            <button
              className="icon-button"
              aria-label="Previous week"
              onClick={() => onWeek(addDays(week, -7))}
            >
              <ChevronLeft size={18} />
            </button>
            <button
              className="icon-button"
              aria-label="Next week"
              onClick={() => onWeek(addDays(week, 7))}
            >
              <ChevronRight size={18} />
            </button>
          </div>
          <h2>{dateRange}</h2>
          <button
            className="small-button today-button"
            onClick={() => {
              const d = new Date(`${today}T12:00:00Z`).getUTCDay();
              onWeek(addDays(today, -(d === 0 ? 6 : d - 1)));
            }}
          >
            Today
          </button>
        </div>
        <div className="segmented">
          <button
            className={view === 'week' ? 'selected' : ''}
            aria-pressed={view === 'week'}
            onClick={() => onView('week')}
          >
            <CalendarDays size={15} />
            Week
          </button>
          <button
            className={view === 'list' ? 'selected' : ''}
            aria-pressed={view === 'list'}
            onClick={() => onView('list')}
          >
            <List size={15} />
            List
          </button>
        </div>
      </div>
      {view === 'list' ? (
        <ShiftList
          shifts={visible.sort((a, b) => a.start.localeCompare(b.start))}
          data={data}
          onSelect={onSelect}
        />
      ) : (
        <div className="calendar-scroll">
          <div className="calendar-min-width">
            <div className="calendar-day-header">
              <div className="timezone-label">
                {data.timezone.split('/').pop()}
                <br />
                <span>local time</span>
              </div>
              {days.map((day) => (
                <div key={day} className={`day-header ${day === today ? 'is-today' : ''}`}>
                  <span>{dateLabel(day, { weekday: 'short' })}</span>
                  <strong>{dateLabel(day, { day: 'numeric' })}</strong>
                </div>
              ))}
            </div>
            <div className="calendar-body" style={{ height: (maxHour - minHour) * hourHeight }}>
              <div className="time-axis">
                {Array.from({ length: maxHour - minHour }, (_, i) => minHour + i).map((h) => (
                  <span key={h} style={{ top: (h - minHour) * hourHeight }}>
                    {h === 0 ? '12 am' : h < 12 ? `${h} am` : h === 12 ? '12 pm' : `${h - 12} pm`}
                  </span>
                ))}
              </div>
              {days.map((day, i) => (
                <div
                  className={`day-column ${day === today ? 'is-today' : ''} ${i > 4 ? 'is-weekend' : ''}`}
                  key={day}
                  style={{ backgroundSize: `100% ${hourHeight}px` }}
                >
                  <button
                    className="add-day"
                    title={`New request for ${dateLabel(day, { weekday: 'long', day: 'numeric', month: 'long' })}`}
                    aria-label={`Add shift on ${day}`}
                    onClick={() => onNew(day)}
                  >
                    <Plus size={15} />
                  </button>
                  {columns[i].map(({ shift, start, end, lane, lanes }) => {
                    const p = data.participants.find((p) => p.id === shift.participantId);
                    const worker = data.staff.find((s) => s.id === shift.staffId);
                    return (
                      <button
                        key={shift.id}
                        className={`calendar-shift shift-color-${shift.kind === 'event' ? 'lilac' : shift.status === 'requested' ? 'peach' : 'sage'} ${shift.status === 'requested' || shift.pendingChange ? 'shift-pending' : ''} ${lanes > 1 ? 'compact-shift' : ''}`}
                        onClick={() => onSelect(shift)}
                        style={{
                          top: ((start - minHour * 60) / 60) * hourHeight + 4,
                          height: Math.max(35, ((end - start) / 60) * hourHeight - 8),
                          left: `calc(${(lane / lanes) * 100}% + 5px)`,
                          width: `calc(${100 / lanes}% - 10px)`,
                        }}
                        aria-label={`${p?.name}, ${shift.description}, ${time(shift.start, data.timezone)} to ${time(shift.end, data.timezone)}, ${shift.status}`}
                      >
                        <span className="shift-card-time">
                          {time(shift.start, data.timezone).replace(':00', '')} –{' '}
                          {time(shift.end, data.timezone).replace(':00', '')}
                          {shift.status === 'requested' && <Clock3 size={11} />}
                        </span>
                        <strong>{p?.name}</strong>
                        <span className="shift-card-description">
                          {shift.kind === 'event'
                            ? shift.description.replace(/^Support for /, '')
                            : shift.description}
                        </span>
                        {end - start >= 110 && (
                          <span className="shift-card-worker">
                            <span className="worker-mini">{worker?.initials || '–'}</span>
                            {(worker?.name || shift.staffDisplayName)?.split(' ')[0] ||
                              'Unassigned'}
                          </span>
                        )}
                        {end - start >= 170 && shift.location && (
                          <span className="shift-card-location">
                            <MapPin size={11} />
                            {shift.location}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      <footer className="calendar-footer">
        <div className="legend">
          <span>
            <i className="legend-green" />
            General support
          </span>
          <span>
            <i className="legend-purple" />
            Event support
          </span>
          <span>
            <i className="legend-peach" />
            Awaiting approval
          </span>
        </div>
        <span>{visible.length} shifts this week</span>
      </footer>
    </section>
  );
}
