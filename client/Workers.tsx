import { useState, type FormEvent } from 'react';
import { Plus, Pencil, RefreshCw } from 'lucide-react';
import type { DashboardData, StaffMember } from '../shared/types';
import { isActiveWorker } from '../shared/views';
import { post, patch } from './api';
import { Avatar, Empty, ErrorNotice, Modal, Spinner } from './ui';

export default function Workers({
  data,
  onSaved,
}: {
  data: DashboardData;
  onSaved: () => Promise<unknown>;
}) {
  const [editing, setEditing] = useState<StaffMember | 'new' | null>(null);
  const [name, setName] = useState('');
  const [airtableId, setAirtableId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const workers = data.staff.filter(isActiveWorker);
  const automatic = data.workerSync?.automatic;
  async function refreshWorkers() {
    setRefreshing(true);
    setRefreshError('');
    try {
      await post('/integrations/airtable/workers', {});
      await onSaved();
    } catch (error) {
      setRefreshError((error as Error).message);
    } finally {
      setRefreshing(false);
    }
  }
  function open(worker: StaffMember | 'new') {
    setEditing(worker);
    setName(worker === 'new' ? '' : worker.name);
    setAirtableId(worker === 'new' ? '' : (worker.airtableId ?? ''));
    setError('');
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    setBusy(true);
    setError('');
    try {
      const values = { name, ...(airtableId.trim() ? { airtableId: airtableId.trim() } : {}) };
      if (editing === 'new') await post('/workers', values);
      else await patch(`/workers/${editing.id}`, values);
      await onSaved();
      setEditing(null);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="accounts-page">
      <div className="accounts-intro">
        <p>
          {automatic
            ? 'Active staff and active volunteers sync from Airtable every five minutes.'
            : 'Add workers to assign shifts. Workers do not receive a portal login.'}
        </p>
        {automatic ? (
          <button className="secondary-button" disabled={refreshing} onClick={refreshWorkers}>
            {refreshing ? <Spinner /> : <RefreshCw size={17} />}
            Refresh workers
          </button>
        ) : (
          <button className="primary-button" onClick={() => open('new')}>
            <Plus size={17} />
            Add worker
          </button>
        )}
      </div>
      {automatic && data.workerSync?.checkedAt && (
        <p className="field-hint">
          Last synced{' '}
          {new Date(data.workerSync.checkedAt).toLocaleString('en-AU', { timeZone: data.timezone })}
          .
        </p>
      )}
      {(refreshError || data.workerSync?.error) && (
        <ErrorNotice>{refreshError || data.workerSync?.error}</ErrorNotice>
      )}
      {workers.length === 0 && (
        <Empty title="No active support workers">
          {automatic
            ? 'Refresh workers to check the current Airtable staff list.'
            : 'Add your first support worker to start assigning shifts.'}
        </Empty>
      )}
      <div className="content-panel accounts-panel">
        {workers.map((worker) => (
          <article className="account-row" key={worker.id}>
            <Avatar name={worker.name} color={worker.color} />
            <div className="account-person">
              <h3>{worker.name}</h3>
              <p>
                {worker.airtableManaged
                  ? 'Synced from Airtable'
                  : worker.airtableId
                    ? 'Linked to Airtable'
                    : 'Local worker'}
              </p>
            </div>
            {!worker.airtableManaged && (
              <button
                className="secondary-button"
                onClick={() => open(worker)}
                aria-label={`Edit worker ${worker.name}`}
              >
                <Pencil size={15} />
                Edit worker
              </button>
            )}
          </article>
        ))}
      </div>
      {editing && (
        <Modal
          title={editing === 'new' ? 'Add support worker' : 'Edit support worker'}
          onClose={() => !busy && setEditing(null)}
        >
          <form className="access-form" onSubmit={save}>
            <label>
              Worker name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                minLength={2}
                maxLength={150}
              />
            </label>
            <label>
              Airtable Staff record ID
              <input
                value={airtableId}
                onChange={(e) => setAirtableId(e.target.value)}
                placeholder="rec…"
                pattern="rec[a-zA-Z0-9]{14}"
                readOnly={editing !== 'new' && Boolean(editing.airtableId)}
              />
            </label>
            <p className="field-hint">
              Optional for local bookings. To synchronize assignments, copy this worker’s record ID
              from the existing Airtable Staff table. Use the matching person; an existing link
              cannot be replaced.
            </p>
            {error && <ErrorNotice>{error}</ErrorNotice>}
            <div className="form-footer">
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => setEditing(null)}
              >
                Cancel
              </button>
              <button className="primary-button" disabled={busy}>
                {busy ? <Spinner /> : 'Save worker'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
