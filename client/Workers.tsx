import { useState, type FormEvent } from 'react';
import { Plus, Pencil } from 'lucide-react';
import type { DashboardData, StaffMember } from '../shared/types';
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
          Add workers here to make them available for shift assignments. This does not give them a
          portal login.
        </p>
        <button className="primary-button" onClick={() => open('new')}>
          <Plus size={17} />
          Add worker
        </button>
      </div>
      {data.staff.length === 0 && (
        <Empty title="Build your worker roster">
          Add your first support worker to start assigning shifts.
        </Empty>
      )}
      <div className="content-panel accounts-panel">
        {data.staff.map((worker) => (
          <article className="account-row" key={worker.id}>
            <Avatar name={worker.name} color={worker.color} />
            <div className="account-person">
              <h3>{worker.name}</h3>
              <p>{worker.airtableId ? 'Linked to Airtable' : 'Not linked to Airtable'}</p>
            </div>
            <button
              className="secondary-button"
              onClick={() => open(worker)}
              aria-label={`Edit worker ${worker.name}`}
            >
              <Pencil size={15} />
              Edit worker
            </button>
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
