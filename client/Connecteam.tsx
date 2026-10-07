import { useState } from 'react';
import { Link2, RefreshCw } from 'lucide-react';
import type { DashboardData } from '../shared/types';
import { post } from './api';
import { ErrorNotice, Spinner } from './ui';

export default function Connecteam({
  data,
  onSaved,
}: {
  data: DashboardData;
  onSaved: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const status = data.connecteam,
    report = status?.report;
  return (
    <section className="integration-card connecteam-card">
      <div className="integration-card-heading">
        <span className="airtable-mark">
          <Link2 size={27} />
        </span>
        <div>
          <h2>Connecteam</h2>
          <p>NSW scheduler</p>
        </div>
        <span className="status status-requested">Publishing off</span>
      </div>
      <p className="integration-message">
        {status?.configured
          ? 'Check access to NSW and the staff, participant and shift links already in Airtable. This check does not create or publish shifts.'
          : 'Add the Connecteam API key privately in the portal’s Render environment to check the connection.'}
      </p>
      {report && (
        <>
          <div className="integration-stats">
            <div>
              <strong>{report.mappedWorkers}</strong>
              <span>Airtable worker IDs</span>
            </div>
            <div>
              <strong>{report.mappedParticipants}</strong>
              <span>Participant job IDs</span>
            </div>
            <div>
              <strong>{report.existingShiftLinks}</strong>
              <span>Existing shift links</span>
            </div>
            <div>
              <strong>{report.scheduler.name}</strong>
              <span>Scheduler {report.scheduler.schedulerId}</span>
            </div>
          </div>
          <p className="field-hint">
            Checked{' '}
            {new Date(report.checkedAt).toLocaleString('en-AU', { timeZone: data.timezone })}.
          </p>
          {report.issues.length > 0 && <ErrorNotice>{report.issues.join(' ')}</ErrorNotice>}
        </>
      )}
      {(error || status?.error) && <ErrorNotice>{error || status?.error}</ErrorNotice>}
      <div className="inline-actions">
        <button
          className="primary-button"
          disabled={busy || !status?.configured || data.demoMode}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await post('/integrations/connecteam/check', {});
              await onSaved();
            } catch (error) {
              setError((error as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Spinner /> : <RefreshCw size={16} />}Check Connecteam connection
        </button>
      </div>
      <p className="field-hint">
        Existing roster entries need to be matched before publishing can be enabled, to avoid
        creating duplicate shifts.
      </p>
    </section>
  );
}
