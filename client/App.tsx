import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  Bell,
  CalendarDays,
  CalendarHeart,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  HeartHandshake,
  LayoutGrid,
  Link2,
  LogOut,
  Menu,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  UsersRound,
  X,
  RefreshCw,
  Inbox,
  CircleHelp,
} from 'lucide-react';
import type {
  DashboardData,
  Participant,
  Shift,
  ShiftInput,
  SupportEvent,
  SupportType,
} from '../shared/types';
import { api, ApiError, patch, post } from './api';
import {
  addDays,
  dateLabel,
  dayKey,
  duration,
  fmt,
  hoursLabel,
  monday,
  time,
  zonedIso,
} from './dates';
import { Avatar, Empty, ErrorNotice, Spinner, Status, supportLabels } from './ui';
import Schedule, { ShiftList } from './Schedule';
import { EventDetail, EventForm, ParticipantForm, ShiftDetail, ShiftForm } from './forms';
import Workers from './Workers';
import Accounts, { FirstSetup, AcceptInvitation } from './Accounts';

type Page =
  'schedule' | 'requests' | 'participants' | 'events' | 'integration' | 'accounts' | 'workers';
const pageNames: Record<Page, string> = {
  schedule: 'Support schedule',
  requests: 'Requests',
  participants: 'Participants',
  events: 'Event support',
  integration: 'Airtable connection',
  accounts: 'People & access',
  workers: 'Support workers',
};

function Brand({ light = false }: { light?: boolean }) {
  return (
    <div className={`brand ${light ? 'brand-light' : ''}`}>
      <span className="brand-symbol">
        <HeartHandshake size={24} strokeWidth={1.65} />
      </span>
      <span>
        <strong>
          mtm<span className="brand-period">.</span>
        </strong>
        <small>mates that matter</small>
      </span>
    </div>
  );
}

function Login({
  demoMode,
  onLogin,
}: {
  demoMode: boolean;
  onLogin: (email: string, password: string) => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function login(emailValue: string, passwordValue: string) {
    setBusy(true);
    setError('');
    try {
      await onLogin(emailValue, passwordValue);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    void login(email, password);
  }
  return (
    <div className="login-page">
      <aside className="login-story">
        <Brand light />
        <div className="login-story-content">
          <span className="eyebrow light-eyebrow">MORE CONNECTION. MORE POSSIBILITY.</span>
          <h1>
            Your people.
            <br />
            Your plans.
            <br />
            <em>Your kind of support.</em>
          </h1>
          <p>
            A little help to get out there, do your thing,
            <br className="desktop-only" /> and make more of every day.
          </p>
          <div className="login-art" aria-hidden="true">
            <span className="art-orbit orbit-one" />
            <span className="art-orbit orbit-two" />
            <div className="art-card art-card-back">
              <CalendarHeart size={25} />
              <span>Space for what matters.</span>
            </div>
            <div className="art-card art-card-front">
              <span className="art-check">
                <Check size={20} />
              </span>
              <div>
                <strong>Your next adventure</strong>
                <span>With the right support beside you.</span>
              </div>
              <span className="art-spark">
                <Sparkles size={23} />
              </span>
            </div>
            <span className="art-flower">✳</span>
          </div>
        </div>
        <div className="login-story-footer">
          <HeartHandshake size={17} />
          Thoughtful support. Real connections.
        </div>
      </aside>
      <main className="login-main">
        <div className="login-top">
          <span>SUPPORT BOOKINGS</span>
          <span className="secure-label">
            <ShieldCheck size={15} />
            Your private portal
          </span>
        </div>
        <div className="login-form-container">
          <span className="login-welcome-icon">
            <CalendarHeart size={26} />
          </span>
          <h2>Good to see you.</h2>
          <p>Sign in to see what’s coming up and plan your next support.</p>
          <form onSubmit={submit}>
            <label>
              Email address
              <input
                type="email"
                name="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="username"
                required
              />
            </label>
            <label>
              Password
              <input
                type="password"
                name="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                autoComplete="current-password"
                required
              />
            </label>
            {error && <ErrorNotice>{error}</ErrorNotice>}
            <button className="primary-button login-submit" disabled={busy}>
              {busy ? (
                <Spinner />
              ) : (
                <>
                  Sign in
                  <ArrowRight size={18} />
                </>
              )}
            </button>
          </form>
          <p className="login-help">
            Need access or a password reset?
            <br />
            Contact your MTM coordinator for a private access link.
          </p>
          {demoMode && (
            <div className="demo-login">
              <div>
                <Sparkles size={15} />
                <span>Take a look around</span>
                <small>Fictional demo data</small>
              </div>
              <div className="demo-role-buttons">
                <button
                  disabled={busy}
                  onClick={() => login('coordinator@mtm.demo', 'DemoSupport!2026')}
                >
                  Staff workspace
                  <ArrowUpRight size={15} />
                </button>
                <button disabled={busy} onClick={() => login('alex@mtm.demo', 'DemoSupport!2026')}>
                  Client portal
                  <ArrowUpRight size={15} />
                </button>
              </div>
            </div>
          )}
        </div>
        <footer className="login-footer">A little planning. A world of possibility.</footer>
      </main>
    </div>
  );
}

export default function App() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [booting, setBooting] = useState(true);
  const [demoMode, setDemoMode] = useState(false);
  const [setupRequired, setSetupRequired] = useState(false);
  const [inviteToken, setInviteToken] = useState(
    () => new URLSearchParams(window.location.hash.slice(1)).get('invite') || '',
  );
  const [bootError, setBootError] = useState('');
  const [page, setPage] = useState<Page>('schedule');
  const [mobileNav, setMobileNav] = useState(false);
  const [search, setSearch] = useState('');
  const [participantId, setParticipantId] = useState('all');
  const [showHidden, setShowHidden] = useState(false);
  const [week, setWeek] = useState(monday(dayKey(new Date())));
  const [view, setView] = useState<'week' | 'list'>('week');
  const [requestFilter, setRequestFilter] = useState<'pending' | 'all'>('pending');
  const [selectedShiftId, setSelectedShiftId] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [shiftForm, setShiftForm] = useState<{
    existing?: Shift;
    day?: string;
    participant?: string;
  } | null>(null);
  const [participantForm, setParticipantForm] = useState(false);
  const [eventForm, setEventForm] = useState(false);
  const [toast, setToast] = useState('');
  const [globalError, setGlobalError] = useState('');
  const [busy, setBusy] = useState(false);
  const [schema, setSchema] = useState<unknown>(null);
  const refresh = useCallback(async () => {
    const next = await api<DashboardData>('/dashboard');
    setData(next);
    setDemoMode(next.demoMode);
    return next;
  }, []);
  const boot = useCallback(async () => {
    setBooting(true);
    setBootError('');
    try {
      const config = await api<{ demoMode: boolean; setupRequired?: boolean }>('/config');
      setDemoMode(config.demoMode);
      setSetupRequired(Boolean(config.setupRequired));
      if (!config.setupRequired) await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setData(null);
      else setBootError((e as Error).message);
    } finally {
      setBooting(false);
    }
  }, [refresh]);
  useEffect(() => {
    void boot();
  }, [boot]);
  useEffect(() => {
    const changed = () =>
      setInviteToken(new URLSearchParams(window.location.hash.slice(1)).get('invite') || '');
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  async function completeAccountSetup() {
    await refresh();
    setSetupRequired(false);
    setInviteToken('');
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    setPage('schedule');
    setParticipantId('all');
    setSearch('');
  }
  function exitInvitation() {
    setInviteToken('');
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(''), 5000);
    return () => clearTimeout(id);
  }, [toast]);
  useEffect(() => {
    if (!data?.user.id) return;
    let active = true;
    const checkForUpdates = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const next = await api<DashboardData>('/dashboard');
        if (active) setData(next);
      } catch (error) {
        if (!active) return;
        if (error instanceof ApiError && error.status === 401) setData(null);
        else
          setGlobalError(
            'We could not refresh your schedule. Your last loaded details are still shown.',
          );
      }
    };
    const timer = window.setInterval(() => void checkForUpdates(), 30_000);
    window.addEventListener('focus', checkForUpdates);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', checkForUpdates);
    };
  }, [data?.user.id]);
  async function login(email: string, password: string) {
    await post('/auth/login', { email, password });
    const next = await refresh();
    setWeek(monday(dayKey(new Date(), next.timezone)));
    setPage('schedule');
    setParticipantId('all');
    setSearch('');
  }
  async function logout() {
    setGlobalError('');
    try {
      await post('/auth/logout');
      setData(null);
      setSelectedShiftId(null);
      setSelectedEventId(null);
      setShiftForm(null);
    } catch (e) {
      setGlobalError((e as Error).message);
    }
  }
  async function mutate(action: () => Promise<unknown>, message: string) {
    await action();
    await refresh();
    setToast(message);
  }
  async function globalAction(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    setGlobalError('');
    try {
      await mutate(action, message);
    } catch (e) {
      setGlobalError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function navigate(next: Page) {
    if (next !== 'schedule') setParticipantId('all');
    setPage(next);
    setSearch('');
    setMobileNav(false);
    setGlobalError('');
  }
  const staff = data?.user.role === 'staff';
  const pending = data?.shifts.filter((s) => s.status === 'requested' || s.pendingChange) || [];
  const matchingShifts = useMemo(
    () =>
      data?.shifts
        .filter(
          (s) =>
            (participantId === 'all' || s.participantId === participantId) &&
            `${s.description} ${s.location} ${data.participants.find((p) => p.id === s.participantId)?.name || ''} ${data.staff.find((p) => p.id === s.staffId)?.name || ''}`
              .toLowerCase()
              .includes(search.toLowerCase()),
        )
        .sort((a, b) => a.start.localeCompare(b.start)) || [],
    [data, participantId, search],
  );
  if (booting)
    return (
      <div className="loading-page">
        <Brand />
        <Spinner />
        <p>Getting your support space ready…</p>
      </div>
    );
  if (bootError)
    return (
      <div className="loading-page">
        <Brand />
        <ErrorNotice>{bootError}</ErrorNotice>
        <button className="primary-button" onClick={() => void boot()}>
          Try again
        </button>
      </div>
    );
  if (inviteToken)
    return (
      <AcceptInvitation
        token={inviteToken}
        onComplete={completeAccountSetup}
        onExit={exitInvitation}
      />
    );
  if (setupRequired && !data) return <FirstSetup onComplete={completeAccountSetup} />;
  if (!data) return <Login demoMode={demoMode} onLogin={login} />;
  const today = dayKey(new Date(), data.timezone);
  const weekStart = Date.parse(zonedIso(`${week}T00:00`, data.timezone));
  const weekEnd = Date.parse(zonedIso(`${addDays(week, 7)}T00:00`, data.timezone));
  const weekShifts = matchingShifts.filter(
    (s) =>
      s.status !== 'cancelled' &&
      s.status !== 'declined' &&
      Date.parse(s.end) > weekStart &&
      Date.parse(s.start) < weekEnd,
  );
  const activeParticipants = data.participants.filter((p) => p.supportType !== 'none');
  const participantOptions = data.participants.filter(
    (p) => showHidden || p.supportType !== 'none' || !staff,
  );
  const upcoming = data.shifts
    .filter((s) => s.status === 'confirmed' && new Date(s.end) > new Date())
    .sort((a, b) => a.start.localeCompare(b.start));
  const selectedShift = data.shifts.find((s) => s.id === selectedShiftId);
  const selectedEvent = data.events.find((e) => e.id === selectedEventId);
  const navItems: { page: Page; label: string; icon: typeof CalendarDays; count?: number }[] = [
    { page: 'schedule', label: staff ? 'Support schedule' : 'My support', icon: CalendarDays },
    { page: 'requests', label: 'Requests', icon: Inbox, count: pending.length },
    ...(staff ? [{ page: 'participants' as Page, label: 'Participants', icon: UsersRound }] : []),
    ...(staff ? [{ page: 'accounts' as Page, label: 'People & access', icon: ShieldCheck }] : []),
    ...(staff ? [{ page: 'workers' as Page, label: 'Support workers', icon: UsersRound }] : []),
    { page: 'events', label: 'Event support', icon: CalendarHeart },
  ];
  return (
    <div className="app-shell">
      {mobileNav && (
        <button
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setMobileNav(false)}
        />
      )}
      <aside className={`sidebar ${mobileNav ? 'mobile-open' : ''}`}>
        <div className="sidebar-brand">
          <Brand />
          <button
            className="icon-button mobile-only"
            aria-label="Close navigation"
            onClick={() => setMobileNav(false)}
          >
            <X size={20} />
          </button>
        </div>
        <div className="workspace-pill">
          <span className="workspace-monogram">M</span>
          <span>
            <strong>{staff ? 'MTM workspace' : 'Your support space'}</strong>
            <small>{staff ? 'Support coordination' : 'Client portal'}</small>
          </span>
          <ShieldCheck size={16} />
        </div>
        <span className="nav-section-label">{staff ? 'WORKSPACE' : 'MY PORTAL'}</span>
        <nav aria-label="Main navigation">
          {navItems.map((item) => (
            <button
              key={item.page}
              className={`nav-link ${page === item.page ? 'active' : ''}`}
              onClick={() => navigate(item.page)}
              aria-current={page === item.page ? 'page' : undefined}
            >
              <item.icon size={19} strokeWidth={1.7} />
              <span>{item.label}</span>
              {!!item.count && <span className="nav-count">{item.count}</span>}
            </button>
          ))}
        </nav>
        {staff && (
          <>
            <span className="nav-section-label settings-label">CONNECTED TOOLS</span>
            <button
              className={`nav-link ${page === 'integration' ? 'active' : ''}`}
              onClick={() => navigate('integration')}
            >
              <Link2 size={19} />
              <span>Airtable</span>
              <span
                className={`connection-dot ${data.integration.configured ? 'connected' : ''}`}
              />
            </button>
          </>
        )}
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <span className="note-flower">✳</span>
            <h3>
              People first.
              <br />
              Plans that follow.
            </h3>
            <p>A little coordination makes room for a lot of possibility.</p>
            <span>
              THAT’S THE MTM WAY
              <ArrowUpRight size={14} />
            </span>
          </div>
          {demoMode && (
            <button
              className="switch-demo"
              disabled={busy}
              onClick={() =>
                void globalAction(
                  () => login(staff ? 'alex@mtm.demo' : 'coordinator@mtm.demo', 'DemoSupport!2026'),
                  `Switched to the ${staff ? 'client' : 'staff'} demo`,
                )
              }
            >
              <Sparkles size={15} />
              Try the {staff ? 'client' : 'staff'} view
              <ArrowRight size={14} />
            </button>
          )}
          <div className="sidebar-user">
            <Avatar name={data.user.name} color="sage" small />
            <span>
              <strong>{data.user.name}</strong>
              <small>{staff ? 'Coordinator' : 'Client account'}</small>
            </span>
            <button
              className="icon-button"
              onClick={() => void logout()}
              title="Sign out"
              aria-label="Sign out"
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-only"
              aria-label="Open navigation"
              onClick={() => setMobileNav(true)}
            >
              <Menu size={21} />
            </button>
            <span>{staff ? 'Workspace' : 'Client portal'}</span>
            <ChevronRight size={14} />
            <strong>
              {staff ? pageNames[page] : page === 'schedule' ? 'My support' : pageNames[page]}
            </strong>
          </div>
          <div className="topbar-right">
            {demoMode && (
              <span className="demo-badge">
                <span />
                Demo workspace
              </span>
            )}
            <span className="topbar-divider" />
            <button
              className="notification-button"
              aria-label={`View ${pending.length} pending requests`}
              onClick={() => navigate('requests')}
            >
              <Bell size={19} />
              {pending.length > 0 && <i />}
            </button>
            <Avatar name={data.user.name} color="peach" small />
          </div>
        </header>
        <main className="main-content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {page === 'schedule'
                  ? 'A LITTLE PLANNING. MORE POSSIBILITY.'
                  : page === 'participants'
                    ? 'THE PEOPLE AT THE HEART OF IT'
                    : page === 'requests'
                      ? 'GOOD SUPPORT STARTS HERE'
                      : page === 'events'
                        ? 'BETTER EXPERIENCES, TOGETHER'
                        : 'KEEP EVERYONE ON THE SAME PAGE'}
              </div>
              <h1>
                {staff
                  ? pageNames[page]
                  : page === 'schedule'
                    ? `Your support, ${data.user.name.split(' ')[0]}.`
                    : pageNames[page]}
              </h1>
              <p>
                {
                  {
                    schedule: staff
                      ? 'A clear view of the week, and the people you’re supporting.'
                      : 'See what’s coming up, make a plan, and let us know what you need.',
                    requests: 'Review new requests and changes, with the whole picture in view.',
                    participants: 'Support that fits each person, whatever their plans look like.',
                    events: 'From an RSVP to the right support, with room on either side.',
                    integration:
                      'Connect your support requests to the tools your team already uses.',
                    workers: 'Manage the people available for support assignments.',
                    accounts: 'Invite people and choose whose support they can access.',
                  }[page]
                }
              </p>
            </div>
            {page !== 'integration' && page !== 'accounts' && page !== 'workers' && (
              <button
                className="primary-button new-request-button"
                onClick={() =>
                  page === 'participants'
                    ? setParticipantForm(true)
                    : page === 'events' && staff
                      ? setEventForm(true)
                      : setShiftForm({
                          participant: participantId === 'all' ? undefined : participantId,
                        })
                }
              >
                <Plus size={18} />
                {page === 'participants'
                  ? 'Add participant'
                  : page === 'events' && staff
                    ? 'Create event'
                    : staff
                      ? 'New shift request'
                      : 'Request support'}
              </button>
            )}
          </div>
          {globalError && (
            <div className="global-error">
              <ErrorNotice>{globalError}</ErrorNotice>
              <button
                className="icon-button"
                aria-label="Dismiss error"
                onClick={() => setGlobalError('')}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {page === 'schedule' && (
            <>
              <div className="stat-grid">
                <Stat
                  icon={CalendarDays}
                  label="Shifts this week"
                  value={weekShifts.length}
                  detail={`${weekShifts.filter((s) => s.status === 'confirmed').length} confirmed on the calendar`}
                  color="sage"
                />
                <Stat
                  icon={Clock3}
                  label="Awaiting approval"
                  value={pending.length}
                  detail={
                    staff ? 'A little attention needed' : 'Your coordinator will review these'
                  }
                  color="peach"
                  action={() => navigate('requests')}
                />
                <Stat
                  icon={staff ? UsersRound : HeartHandshake}
                  label={staff ? 'Active participants' : 'Your participants'}
                  value={staff ? activeParticipants.length : data.participants.length}
                  detail={staff ? 'General and event support' : 'Support linked to your account'}
                  color="lilac"
                  action={staff ? () => navigate('participants') : undefined}
                />
                <Stat
                  icon={HeartHandshake}
                  label="Support this week"
                  value={hoursLabel(
                    weekShifts.reduce(
                      (sum, s) =>
                        sum +
                        (Math.min(Date.parse(s.end), weekEnd) -
                          Math.max(Date.parse(s.start), weekStart)) /
                          3_600_000,
                      0,
                    ),
                  )}
                  detail="Time for the things that matter"
                  color="blue"
                />
              </div>
              <div className="schedule-section-heading">
                <div>
                  <h2>{staff ? 'The week ahead' : 'Your week ahead'}</h2>
                  <span>Every plan starts with a person.</span>
                </div>
                <div className="schedule-filters">
                  <div className="search-field">
                    <Search size={16} />
                    <input
                      aria-label="Search shifts"
                      placeholder="Find a shift or person…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    {search && (
                      <button aria-label="Clear search" onClick={() => setSearch('')}>
                        <X size={14} />
                      </button>
                    )}
                  </div>
                  <div className="participant-select">
                    <UsersRound size={16} />
                    <select
                      aria-label="Filter calendar by participant"
                      value={participantId}
                      onChange={(e) => setParticipantId(e.target.value)}
                    >
                      <option value="all">All participants</option>
                      {participantOptions.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
              {staff && (
                <label className="hidden-toggle calendar-hidden-toggle">
                  <input
                    type="checkbox"
                    checked={showHidden}
                    onChange={(e) => {
                      setShowHidden(e.target.checked);
                      if (
                        !e.target.checked &&
                        data.participants.find((p) => p.id === participantId)?.supportType ===
                          'none'
                      )
                        setParticipantId('all');
                    }}
                  />
                  Include participants with no regular support
                </label>
              )}
              <Schedule
                data={data}
                shifts={matchingShifts}
                week={week}
                onWeek={setWeek}
                view={view}
                onView={setView}
                onSelect={(s) => setSelectedShiftId(s.id)}
                onNew={(day) =>
                  setShiftForm({
                    day,
                    participant: participantId === 'all' ? undefined : participantId,
                  })
                }
              />
              <div className="schedule-bottom">
                <div className="connection-summary">
                  <span
                    className={`connection-dot ${data.integration.configured ? 'connected' : ''}`}
                  />
                  {staff
                    ? data.integration.configured
                      ? `${data.integration.synced} requests synced with Airtable`
                      : 'Your calendar is saved here. Connect Airtable to sync requests.'
                    : 'Your coordinator reviews requests before confirming support.'}
                  {staff && (
                    <button onClick={() => navigate('integration')}>
                      {data.integration.configured ? 'View connection' : 'Set up connection'}
                      <ArrowUpRight size={13} />
                    </button>
                  )}
                </div>
                <span>
                  <ShieldCheck size={13} />A space built around you
                </span>
              </div>
            </>
          )}
          {page === 'requests' && (
            <section className="content-panel">
              <div className="panel-toolbar">
                <div className="tab-buttons">
                  <button
                    className={requestFilter === 'pending' ? 'active' : ''}
                    onClick={() => setRequestFilter('pending')}
                  >
                    Awaiting review<span>{pending.length}</span>
                  </button>
                  <button
                    className={requestFilter === 'all' ? 'active' : ''}
                    onClick={() => setRequestFilter('all')}
                  >
                    All requests
                  </button>
                </div>
                <div className="search-field">
                  <Search size={16} />
                  <input
                    placeholder="Search requests…"
                    aria-label="Search requests"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
              </div>
              {(requestFilter === 'pending'
                ? matchingShifts.filter((s) => s.status === 'requested' || s.pendingChange)
                : matchingShifts
              ).length ? (
                <ShiftList
                  shifts={
                    requestFilter === 'pending'
                      ? matchingShifts.filter((s) => s.status === 'requested' || s.pendingChange)
                      : matchingShifts
                  }
                  data={data}
                  onSelect={(s) => setSelectedShiftId(s.id)}
                />
              ) : (
                <Empty title={search ? 'No matching requests' : 'You’re all up to date'}>
                  {search
                    ? 'Try another name or support description.'
                    : 'New requests and shift changes will appear here for review.'}
                </Empty>
              )}
              <div className="panel-note">
                <ShieldCheck size={16} />
                {staff
                  ? 'Requests and changes need your approval. Existing bookings stay in place while changes are reviewed.'
                  : 'Your requests are sent to the coordination team. You can check their progress here.'}
              </div>
            </section>
          )}
          {page === 'participants' && staff && (
            <>
              <div className="participant-toolbar">
                <div className="search-field">
                  <Search size={16} />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Find a participant…"
                    aria-label="Find a participant"
                  />
                </div>
                <label className="hidden-toggle">
                  <input
                    type="checkbox"
                    checked={showHidden}
                    onChange={(e) => {
                      setShowHidden(e.target.checked);
                      if (
                        !e.target.checked &&
                        data.participants.find((p) => p.id === participantId)?.supportType ===
                          'none'
                      )
                        setParticipantId('all');
                    }}
                  />
                  Show no regular support
                  <span>{data.participants.filter((p) => p.supportType === 'none').length}</span>
                </label>
              </div>
              <section className="participant-grid">
                {data.participants
                  .filter(
                    (p) =>
                      (showHidden || p.supportType !== 'none') &&
                      p.name.toLowerCase().includes(search.toLowerCase()),
                  )
                  .map((p) => {
                    const next = upcoming.find((s) => s.participantId === p.id);
                    return (
                      <article className="participant-card" key={p.id}>
                        <div className="participant-card-top">
                          <Avatar name={p.name} color={p.color} />
                          <span className={`support-type-tag support-${p.supportType}`}>
                            {supportLabels[p.supportType]}
                          </span>
                        </div>
                        <h3>{p.name}</h3>
                        <p>{p.notes || 'A plan built around their preferences.'}</p>
                        <label>
                          Support setting
                          <select
                            aria-label={`Support setting for ${p.name}`}
                            value={p.supportType}
                            disabled={busy}
                            onChange={(e) =>
                              void globalAction(
                                () =>
                                  patch(`/participants/${p.id}`, { supportType: e.target.value }),
                                `Support setting updated for ${p.name}`,
                              )
                            }
                          >
                            {Object.entries(supportLabels).map(([key, label]) => (
                              <option key={key} value={key}>
                                {label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <div className="participant-next">
                          <CalendarDays size={16} />
                          <span>
                            {next ? (
                              <>
                                <strong>
                                  {fmt(
                                    next.start,
                                    { weekday: 'short', day: 'numeric', month: 'short' },
                                    data.timezone,
                                  )}
                                </strong>{' '}
                                · {time(next.start, data.timezone)}
                              </>
                            ) : (
                              'No confirmed shifts ahead'
                            )}
                          </span>
                        </div>
                        <div className="participant-card-actions">
                          <button
                            onClick={() => {
                              setParticipantId(p.id);
                              setWeek(
                                next ? monday(dayKey(next.start, data.timezone)) : monday(today),
                              );
                              navigate('schedule');
                            }}
                          >
                            View schedule
                            <ArrowUpRight size={14} />
                          </button>
                          <button
                            aria-label={`Request support for ${p.name}`}
                            title="Request support"
                            onClick={() => setShiftForm({ participant: p.id })}
                          >
                            <Plus size={17} />
                          </button>
                        </div>
                      </article>
                    );
                  })}
              </section>
              {!data.participants.filter(
                (p) =>
                  (showHidden || p.supportType !== 'none') &&
                  p.name.toLowerCase().includes(search.toLowerCase()),
              ).length && (
                <Empty title="No participants found">
                  Try another name or include participants with no regular support.
                </Empty>
              )}
              <div className="info-strip">
                <CalendarHeart size={19} />
                <p>
                  <strong>Event support, without the extra admin.</strong> Participants set to event
                  support or both receive a shift request when they RSVP, including 30 minutes
                  before and after.
                </p>
              </div>
            </>
          )}
          {page === 'events' && (
            <>
              <div className="event-rule-banner">
                <div className="event-rule-icon">
                  <Sparkles size={23} />
                </div>
                <div>
                  <h3>A little extra time makes all the difference.</h3>
                  <p>
                    Eligible RSVPs become support requests, with 30 minutes on either side of the
                    event.
                  </p>
                </div>
                <span className="rule-pill">30 min + event + 30 min</span>
              </div>
              <div className="section-heading">
                <h2>{staff ? 'Events & RSVPs' : 'Your events'}</h2>
                <span>{data.events.length} events</span>
              </div>
              <div className="event-grid">
                {data.events.map((event, index) => (
                  <button
                    key={event.id}
                    className={`event-card event-theme-${index % 3}`}
                    onClick={() => setSelectedEventId(event.id)}
                  >
                    <div className="event-art">
                      <span className="event-art-circle circle-a" />
                      <span className="event-art-circle circle-b" />
                      <CalendarHeart size={42} strokeWidth={1.2} />
                      <div className="event-date">
                        <strong>{fmt(event.start, { day: 'numeric' }, data.timezone)}</strong>
                        <span>{fmt(event.start, { month: 'short' }, data.timezone)}</span>
                      </div>
                      <span className="event-art-star">✳</span>
                    </div>
                    <div className="event-card-body">
                      <span className="event-day-label">
                        {fmt(event.start, { weekday: 'long' }, data.timezone)}
                      </span>
                      <h3>{event.title}</h3>
                      <p>
                        {time(event.start, data.timezone)} – {time(event.end, data.timezone)}
                        <span>·</span>
                        {event.location || 'Location to be arranged'}
                      </p>
                      <div className="event-card-footer">
                        <span>
                          <UsersRound size={15} />
                          {event.rsvpCount} attending
                        </span>
                        <span>
                          {event.supportCount} support requests
                          <ChevronRight size={15} />
                        </span>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
              {!data.events.length && (
                <Empty title="Something to look forward to">
                  Events linked to your support will appear here.
                </Empty>
              )}
            </>
          )}
          {page === 'workers' && staff && <Workers data={data} onSaved={refresh} />}
          {page === 'accounts' && staff && <Accounts data={data} />}
          {page === 'integration' && staff && (
            <>
              <section className="integration-card">
                <div className="integration-card-heading">
                  <span className="airtable-mark">
                    <LayoutGrid size={27} />
                  </span>
                  <div>
                    <h2>Airtable</h2>
                    <p>Your existing base, connected to your support workspace.</p>
                  </div>
                  <span
                    className={`status ${data.integration.configured ? 'status-confirmed' : 'status-requested'}`}
                  >
                    <span
                      className={`connection-dot ${data.integration.configured ? 'connected' : ''}`}
                    />
                    {data.integration.configured ? 'Configured' : 'Setup needed'}
                  </span>
                </div>
                <div className="integration-stats">
                  <div>
                    <strong>{data.integration.synced}</strong>
                    <span>Synced requests</span>
                  </div>
                  <div>
                    <strong>{data.integration.pending}</strong>
                    <span>Waiting to sync</span>
                  </div>
                  <div>
                    <strong>{data.integration.failed}</strong>
                    <span>Need attention</span>
                  </div>
                  <div>
                    <strong>
                      {data.integration.lastSync
                        ? fmt(
                            data.integration.lastSync,
                            { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' },
                            data.timezone,
                          )
                        : '—'}
                    </strong>
                    <span>Last successful sync</span>
                  </div>
                </div>
                <p className="integration-message">
                  {data.integration.message ||
                    'Add your base details and a server-side Airtable token to connect.'}
                </p>
                <div className="inline-actions">
                  <button
                    className="primary-button"
                    disabled={busy || !data.integration.configured}
                    onClick={() =>
                      void globalAction(
                        () => post('/integrations/airtable/sync'),
                        'Sync run completed; check request sync status below.',
                      )
                    }
                  >
                    <RefreshCw size={16} className={busy ? 'spin' : ''} />
                    Sync requests
                  </button>
                  <button
                    className="secondary-button"
                    disabled={busy || !data.integration.configured || data.demoMode}
                    onClick={() =>
                      void globalAction(
                        () => post('/integrations/airtable/import'),
                        'Initial Airtable data imported; existing portal decisions preserved.',
                      )
                    }
                  >
                    <UsersRound size={16} />
                    Import initial data
                  </button>
                  <button
                    className="secondary-button"
                    disabled={busy || !data.integration.configured}
                    onClick={async () => {
                      setBusy(true);
                      setGlobalError('');
                      try {
                        setSchema(await api('/integrations/airtable/schema'));
                      } catch (e) {
                        setGlobalError((e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <Search size={16} />
                    Check base fields
                  </button>
                </div>
              </section>
              <div className="integration-info-grid">
                <section className="content-panel integration-guide">
                  <span className="eyebrow">THE CONNECTION</span>
                  <h3>One request. In both places.</h3>
                  <ol>
                    <li>
                      <span>01</span>
                      <div>
                        <strong>Connect your existing base</strong>
                        <p>
                          Configure the base ID, participant table, and Airtable token securely on
                          the server.
                        </p>
                      </div>
                    </li>
                    <li>
                      <span>02</span>
                      <div>
                        <strong>Match the fields</strong>
                        <p>
                          Check your actual schema before mapping Participants, Events, RSVPs, and
                          Shift Requests.
                        </p>
                      </div>
                    </li>
                    <li>
                      <span>03</span>
                      <div>
                        <strong>Turn on RSVP automation</strong>
                        <p>
                          An Airtable automation sends RSVP updates to the authenticated portal
                          webhook.
                        </p>
                      </div>
                    </li>
                  </ol>
                </section>
                <section className="content-panel integration-guide">
                  <span className="eyebrow">YOUR TABLES</span>
                  <h3>A familiar home for your data.</h3>
                  <div className="mapping-row">
                    <strong>Shift Requests</strong>
                    <span>Requests, status & preferences</span>
                  </div>
                  <div className="mapping-row">
                    <strong>Events</strong>
                    <span>Start, end & event details</span>
                  </div>
                  <div className="mapping-row">
                    <strong>RSVPs</strong>
                    <span>Participant, event & attendance</span>
                  </div>
                  <div className="mapping-row">
                    <strong>Participants</strong>
                    <span>People &amp; support settings</span>
                  </div>
                  <p className="field-hint">
                    Run the schema check to verify the current table and field mappings. This check
                    does not change your base.
                  </p>
                </section>
              </div>
              {schema !== null && (
                <section className="content-panel schema-result">
                  <h3>Read-only schema audit</h3>
                  <pre>{JSON.stringify(schema, null, 2)}</pre>
                </section>
              )}
              <div className="info-strip">
                <ShieldCheck size={19} />
                <p>
                  API keys stay on the server. Failed syncs remain in the queue for retry, and a
                  stable portal ID prevents duplicate requests.
                </p>
              </div>
            </>
          )}
        </main>
        <footer className="app-footer">
          <span>Thoughtful support. Real connections.</span>
          <span>MTM · Support bookings</span>
        </footer>
      </div>
      {toast && (
        <div className="toast" role="status">
          <span>
            <Check size={17} />
          </span>
          {toast}
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setToast('')}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {shiftForm && (
        <ShiftForm
          key={shiftForm.existing?.id || 'new'}
          data={data}
          existing={shiftForm.existing}
          initialDay={shiftForm.day}
          initialParticipant={shiftForm.participant}
          onClose={() => setShiftForm(null)}
          onSave={async (values) => {
            const existing = shiftForm.existing;
            await mutate(
              () =>
                existing
                  ? patch(`/shifts/${existing.id}`, { action: 'edit', values })
                  : post('/shifts', values),
              existing ? 'Change request sent for approval' : 'Support request sent for approval',
            );
          }}
        />
      )}
      {selectedShift && !shiftForm && (
        <ShiftDetail
          key={selectedShift.id}
          shift={selectedShift}
          data={data}
          onClose={() => setSelectedShiftId(null)}
          onEdit={() => {
            setShiftForm({ existing: selectedShift });
            setSelectedShiftId(null);
          }}
          onAction={async (action, extras) => {
            await mutate(
              () => patch(`/shifts/${selectedShift.id}`, { action, ...extras }),
              action === 'cancel' && !staff ? 'Cancellation sent for approval' : 'Shift updated',
            );
          }}
        />
      )}
      {participantForm && (
        <ParticipantForm
          onClose={() => setParticipantForm(false)}
          onSave={async (values) => {
            await mutate(() => post('/participants', values), 'Participant added');
          }}
        />
      )}
      {eventForm && (
        <EventForm
          data={data}
          onClose={() => setEventForm(false)}
          onSave={async (values) => {
            await mutate(() => post('/events', values), 'Event created');
          }}
        />
      )}
      {selectedEvent && (
        <EventDetail
          event={selectedEvent}
          data={data}
          onClose={() => setSelectedEventId(null)}
          onRsvp={async (participantId, status) => {
            await mutate(
              () => post(`/events/${selectedEvent.id}/rsvps`, { participantId, status }),
              status === 'attending'
                ? 'RSVP recorded; eligible support requests created'
                : 'RSVP cancelled; related support updated for review',
            );
          }}
        />
      )}
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  detail,
  color,
  action,
}: {
  icon: typeof CalendarDays;
  label: string;
  value: string | number;
  detail: string;
  color: string;
  action?: () => void;
}) {
  return (
    <div className={`stat-card stat-${color}`}>
      <div className="stat-top">
        <span>{label}</span>
        <span className={`stat-icon stat-icon-${color}`}>
          <Icon size={18} strokeWidth={1.7} />
        </span>
      </div>
      <div className="stat-value">
        {value}
        {action && (
          <button aria-label={`View ${label.toLowerCase()}`} onClick={action}>
            <ArrowUpRight size={18} />
          </button>
        )}
      </div>
      <p>{detail}</p>
    </div>
  );
}
