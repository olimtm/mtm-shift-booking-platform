import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowRight,
  Check,
  Copy,
  KeyRound,
  LockKeyhole,
  Mail,
  Plus,
  ShieldCheck,
  UsersRound,
} from 'lucide-react';
import type { DashboardData, User } from '../shared/types';
import { api, patch, post } from './api';
import { fmt } from './dates';
import { Avatar, Empty, ErrorNotice, Modal, Spinner } from './ui';

interface Account extends User {
  disabled: boolean;
}
interface AccessLink {
  url: string;
  expiresAt: string;
}
interface Invitation {
  name: string;
  email: string;
  kind: 'invite' | 'reset';
  expiresAt: string;
}

function AccessShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <main className="access-page">
      <div className="access-brand">
        <ShieldCheck size={24} />
        <span>
          mates that matter<span>SUPPORT BOOKINGS</span>
        </span>
      </div>
      <section className="access-card">
        <span className="access-symbol">
          <LockKeyhole size={25} />
        </span>
        <h1>{title}</h1>
        <p className="access-subtitle">{subtitle}</p>
        {children}
      </section>
      <p className="access-footer">A space built around you.</p>
    </main>
  );
}

export function FirstSetup({ onComplete }: { onComplete: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [setupSecret, setSetupSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('The passwords don’t match. Please check both fields.');
      return;
    }
    setBusy(true);
    try {
      await post('/setup', { name, email, password, setupSecret });
      setPassword('');
      setConfirm('');
      setSetupSecret('');
      await onComplete();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <AccessShell
      title="Make this your workspace."
      subtitle="Create the first coordinator account. You only need to do this once."
    >
      <form onSubmit={submit} className="access-form">
        <label>
          Your name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            minLength={2}
            maxLength={100}
            required
          />
        </label>
        <label>
          Email address
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            maxLength={254}
            required
          />
        </label>
        <label>
          Choose a password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={12}
            maxLength={256}
            required
          />
        </label>
        <label>
          Confirm password
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            minLength={12}
            maxLength={256}
            required
          />
        </label>
        <label>
          Private setup key
          <input
            type="password"
            value={setupSecret}
            onChange={(e) => setSetupSecret(e.target.value)}
            autoComplete="off"
            required
          />
        </label>
        <p className="field-hint">
          Open your hosting service’s Environment settings and copy the value named{' '}
          <strong>MTM_SETUP_SECRET</strong>. This protects your first account from being claimed by
          someone else.
        </p>
        <div className="info-notice">
          <ShieldCheck size={17} />
          <span>
            Coordinators can view all participants, approve bookings, and manage client and staff
            access.
          </span>
        </div>
        {error && <ErrorNotice>{error}</ErrorNotice>}
        <button className="primary-button login-submit" disabled={busy}>
          {busy ? (
            <Spinner />
          ) : (
            <>
              Create my workspace
              <ArrowRight size={17} />
            </>
          )}
        </button>
      </form>
    </AccessShell>
  );
}

export function AcceptInvitation({
  token,
  onComplete,
  onExit,
}: {
  token: string;
  onComplete: () => Promise<void>;
  onExit: () => void;
}) {
  const [details, setDetails] = useState<Invitation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  useEffect(() => {
    let active = true;
    void post<Invitation>('/auth/invitations/inspect', { token })
      .then((value) => {
        if (active) setDetails(value);
      })
      .catch((error) => {
        if (active) setError((error as Error).message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [token]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('The passwords don’t match. Please check both fields.');
      return;
    }
    setBusy(true);
    try {
      await post('/auth/invitations/accept', { token, password });
      setPassword('');
      setConfirm('');
      await onComplete();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <AccessShell
      title={details?.kind === 'reset' ? 'A fresh start.' : 'Welcome to your support space.'}
      subtitle={
        details
          ? `${details.name}, ${details.kind === 'reset' ? 'choose a new password for your account.' : 'choose a password to activate your account.'}`
          : 'Checking your private access link…'
      }
    >
      {loading ? (
        <div className="access-loading">
          <Spinner />
        </div>
      ) : !details ? (
        <>
          <ErrorNotice>{error || 'This link is no longer available.'}</ErrorNotice>
          <p className="access-help">
            Ask your coordinator for a new link, or return to sign in if your account is already
            active.
          </p>
          <button className="secondary-button" onClick={onExit}>
            Back to sign in
          </button>
        </>
      ) : (
        <form onSubmit={submit} className="access-form">
          <div className="invited-email">
            <Mail size={17} />
            {details.email}
          </div>
          <label>
            New password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={12}
              maxLength={256}
              required
            />
          </label>
          <label>
            Confirm password
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              minLength={12}
              maxLength={256}
              required
            />
          </label>
          <p className="field-hint">
            Use at least 12 characters. This is the password you’ll use to sign in.
          </p>
          {error && <ErrorNotice>{error}</ErrorNotice>}
          <button className="primary-button login-submit" disabled={busy}>
            {busy ? (
              <Spinner />
            ) : (
              <>
                {details.kind === 'reset' ? 'Save password and sign in' : 'Activate my account'}
                <ArrowRight size={17} />
              </>
            )}
          </button>
          <button type="button" className="text-link" onClick={onExit} disabled={busy}>
            Back to sign in
          </button>
        </form>
      )}
    </AccessShell>
  );
}

export default function Accounts({ data }: { data: DashboardData }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState(false);
  const [edit, setEdit] = useState<Account | null>(null);
  const [link, setLink] = useState<
    (AccessLink & { name: string; kind: 'invite' | 'reset' }) | null
  >(null);
  async function load() {
    const result = await api<{ accounts: Account[] }>('/accounts');
    setAccounts(result.accounts);
  }
  useEffect(() => {
    void load()
      .catch((error) => setError((error as Error).message))
      .finally(() => setLoading(false));
  }, []);
  async function toggle(account: Account) {
    setBusy(true);
    setError('');
    try {
      await patch(`/accounts/${account.id}`, { disabled: !account.disabled });
      await load();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function reset(account: Account) {
    setBusy(true);
    setError('');
    try {
      const result = await post<AccessLink>(`/accounts/${account.id}/reset`);
      setLink({ ...result, name: account.name, kind: 'reset' });
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="accounts-intro">
        <div className="info-notice">
          <ShieldCheck size={18} />
          <span>
            Each client sees only the participants you link to their account. Coordinators can
            manage the whole workspace.
          </span>
        </div>
        <button className="primary-button" onClick={() => setInvite(true)}>
          <Plus size={17} />
          Invite someone
        </button>
      </div>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      <section className="content-panel accounts-panel">
        {loading ? (
          <div className="access-loading">
            <Spinner />
          </div>
        ) : accounts.length ? (
          accounts.map((account) => (
            <article className="account-row" key={account.id}>
              <Avatar name={account.name} color={account.role === 'staff' ? 'sage' : 'blue'} />
              <div className="account-person">
                <h3>
                  {account.name}
                  {account.id === data.user.id && <small>You</small>}
                </h3>
                <p>{account.email}</p>
                <span>
                  {account.role === 'staff'
                    ? 'Coordinator · full workspace access'
                    : account.participantIds
                        .map(
                          (id) =>
                            data.participants.find((p) => p.id === id)?.name ||
                            'Linked participant',
                        )
                        .join(', ') || 'No participants linked'}
                </span>
              </div>
              <div className="account-actions">
                <span
                  className={`status ${account.disabled ? 'status-cancelled' : 'status-confirmed'}`}
                >
                  {account.disabled ? 'Access inactive' : 'Active'}
                </span>
                {account.role === 'client' && (
                  <button className="small-button" disabled={busy} onClick={() => setEdit(account)}>
                    <UsersRound size={14} />
                    Edit access
                  </button>
                )}
                <button
                  className="small-button"
                  disabled={busy}
                  onClick={() => void reset(account)}
                >
                  <KeyRound size={14} />
                  Password link
                </button>
                <button
                  className={`text-link ${account.disabled ? '' : 'danger-text'}`}
                  disabled={busy || account.id === data.user.id}
                  onClick={() => void toggle(account)}
                >
                  {account.disabled ? 'Enable access' : 'Disable access'}
                </button>
              </div>
            </article>
          ))
        ) : (
          <Empty title="Bring your people into the portal">
            Invite a client or coordinator to get started.
          </Empty>
        )}
      </section>
      <div className="info-strip">
        <Mail size={18} />
        <p>
          <strong>Private invitations, shared by you.</strong> Create a link, then send it directly
          to the intended person using your usual email or messaging service. The app does not send
          emails automatically.
        </p>
      </div>
      {invite && (
        <InviteForm
          data={data}
          onClose={() => setInvite(false)}
          onSave={async (values) => {
            const result = await post<AccessLink>('/accounts/invitations', values);
            await load();
            setInvite(false);
            setLink({ ...result, name: values.name, kind: 'invite' });
          }}
        />
      )}
      {edit && (
        <AccessForm
          account={edit}
          data={data}
          onClose={() => setEdit(null)}
          onSave={async (participantIds) => {
            await patch(`/accounts/${edit.id}`, { participantIds });
            await load();
            setEdit(null);
          }}
        />
      )}
      {link && <LinkDialog details={link} timezone={data.timezone} onClose={() => setLink(null)} />}
    </>
  );
}

function ParticipantChoices({
  data,
  selected,
  onChange,
}: {
  data: DashboardData;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <fieldset className="participant-choices">
      <legend>Participants this person can manage</legend>
      {data.participants.length ? (
        data.participants.map((participant) => (
          <label key={participant.id}>
            <input
              type="checkbox"
              checked={selected.includes(participant.id)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...selected, participant.id]
                    : selected.filter((id) => id !== participant.id),
                )
              }
            />
            <span>
              {participant.name}
              {participant.supportType === 'none' && <small>No regular support</small>}
            </span>
          </label>
        ))
      ) : (
        <p>Add or import participants before inviting a client.</p>
      )}
    </fieldset>
  );
}

function InviteForm({
  data,
  onClose,
  onSave,
}: {
  data: DashboardData;
  onClose: () => void;
  onSave: (values: {
    name: string;
    email: string;
    role: 'staff' | 'client';
    participantIds: string[];
  }) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'staff' | 'client'>('client');
  const [participantIds, setParticipantIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await onSave({ name, email, role, participantIds: role === 'staff' ? [] : participantIds });
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Invite someone to the portal"
      subtitle="You choose their access. They choose their own password."
      onClose={busy ? () => {} : onClose}
    >
      <form className="form-body" onSubmit={submit}>
        <label>
          Full name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            minLength={2}
            maxLength={100}
            required
          />
        </label>
        <label>
          Email address
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={254}
            required
          />
        </label>
        <label>
          Account type
          <select value={role} onChange={(e) => setRole(e.target.value as 'staff' | 'client')}>
            <option value="client">Client or representative</option>
            <option value="staff">Staff coordinator</option>
          </select>
        </label>
        {role === 'client' ? (
          <ParticipantChoices data={data} selected={participantIds} onChange={setParticipantIds} />
        ) : (
          <div className="info-notice">
            <ShieldCheck size={17} />
            <span>
              This person will be able to view all participants, approve bookings, and manage other
              people’s access.
            </span>
          </div>
        )}
        {error && <ErrorNotice>{error}</ErrorNotice>}
        <footer className="form-footer">
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={busy || (role === 'client' && !participantIds.length)}
          >
            {busy ? <Spinner /> : <Plus size={16} />}Create invitation link
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function AccessForm({
  account,
  data,
  onClose,
  onSave,
}: {
  account: Account;
  data: DashboardData;
  onClose: () => void;
  onSave: (ids: string[]) => Promise<void>;
}) {
  const [ids, setIds] = useState(account.participantIds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSave(ids);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Access for ${account.name}`}
      subtitle="Only the selected participants will be visible to this account."
      onClose={busy ? () => {} : onClose}
    >
      <form className="form-body" onSubmit={submit}>
        <ParticipantChoices data={data} selected={ids} onChange={setIds} />
        <div className="info-notice">
          <ShieldCheck size={17} />
          <span>
            Updating access signs this person out so their next session uses the new permissions.
          </span>
        </div>
        {error && <ErrorNotice>{error}</ErrorNotice>}
        <footer className="form-footer">
          <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" disabled={busy || !ids.length}>
            {busy ? <Spinner /> : <Check size={16} />}Save access
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function LinkDialog({
  details,
  timezone,
  onClose,
}: {
  details: AccessLink & { name: string; kind: 'invite' | 'reset' };
  timezone: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  async function copy() {
    setError('');
    try {
      await navigator.clipboard.writeText(details.url);
      setCopied(true);
    } catch {
      input.current?.select();
      setError('Select the link and use your device’s Copy command.');
    }
  }
  return (
    <Modal
      title={
        details.kind === 'invite' ? 'Their invitation is ready.' : 'Password reset link ready.'
      }
      subtitle={`Share this privately with ${details.name}.`}
      onClose={onClose}
    >
      <div className="form-body">
        <label>
          Private access link
          <input ref={input} value={details.url} readOnly onFocus={(e) => e.target.select()} />
        </label>
        <p className="field-hint">
          Expires{' '}
          {fmt(
            details.expiresAt,
            { day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' },
            timezone,
          )}
          . This link can be used once.
        </p>
        <div className="info-notice">
          <LockKeyhole size={17} />
          <span>
            Anyone with this link can set the account’s password. Send it only to the intended
            person. It has not been emailed automatically.
          </span>
        </div>
        {error && <ErrorNotice>{error}</ErrorNotice>}
        <footer className="form-footer">
          <button className="secondary-button" onClick={onClose}>
            Done
          </button>
          <button className="primary-button" onClick={() => void copy()}>
            {copied ? <Check size={16} /> : <Copy size={16} />}{' '}
            {copied ? 'Copied' : 'Copy private link'}
          </button>
        </footer>
      </div>
    </Modal>
  );
}
