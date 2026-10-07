import { useState } from 'react';
import { CheckCircle2, Link2, RefreshCw } from 'lucide-react';
import type { ConnecteamSetupStatus, DashboardData } from '../shared/types';
import { post } from './api';
import { ErrorNotice, Spinner } from './ui';

export default function Connecteam({
  data,
  onChecked,
}: {
  data: DashboardData;
  onChecked: (status: ConnecteamSetupStatus) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [checked, setChecked] = useState(false);
  const status = data.connecteam,
    report = status?.report,
    failure = error || status?.error;
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
      <div role="status" aria-live="polite" aria-atomic="true">
        {busy ? (
          <p className="info-notice connecteam-result">
            <Spinner />
            Checking Connecteam and Airtable links…
          </p>
        ) : report && !failure ? (
          <div className="info-notice connecteam-result">
            <CheckCircle2 size={19} aria-hidden="true" />
            <div>
              <strong>{checked ? 'Connection check complete.' : 'Connection verified.'}</strong>
              <p>
                Connected to {report.scheduler.name}.{' '}
                {report.issues.length
                  ? 'Some Airtable links need attention below.'
                  : 'No mapping issues found.'}{' '}
                Shift publishing is still off.
              </p>
            </div>
          </div>
        ) : null}
      </div>
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
              <span>Airtable shift IDs</span>
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
      {!busy && failure && <ErrorNotice>{failure}</ErrorNotice>}
      <div className="inline-actions">
        <button
          className="primary-button"
          disabled={busy || !status?.configured || data.demoMode}
          aria-busy={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              const next = await post<ConnecteamSetupStatus>('/integrations/connecteam/check', {});
              onChecked(next);
              setChecked(true);
            } catch (error) {
              setError((error as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Spinner /> : <RefreshCw size={16} />}
          {busy ? 'Checking connection…' : 'Check Connecteam connection'}
        </button>
      </div>
      <p className="field-hint">
        Existing roster entries need to be matched before publishing can be enabled, to avoid
        creating duplicate shifts.
      </p>
      {status?.importError && <ErrorNotice>{status.importError}</ErrorNotice>}
      {status?.importReport && (
        <div className="connecteam-import-report">
          <h3>One-off roster import</h3>
          <p className="info-notice">
            {status.importReport.state === 'completed'
              ? 'Import completed. Connecteam took precedence for matched shifts.'
              : 'Import preview ready. Portal shifts have not changed.'}{' '}
            Automatic publishing is off.
          </p>
          <p>
            {status.importReport.created} added · {status.importReport.updated} updated ·{' '}
            {status.importReport.unchanged} already matched · {status.importReport.cancelled}{' '}
            cancelled
          </p>
          <p>
            {status.importReport.past} past shifts · {status.importReport.upcoming} upcoming shifts
          </p>
          <p className="field-hint">
            {status.importReport.issues.length} Connecteam shifts need review or belong to other
            jobs. {status.importReport.unmatchedPortal.length} unmatched portal requests preserved.
          </p>
          {(status.importReport.issues.length > 0 ||
            status.importReport.unmatchedPortal.length > 0) && (
            <details>
              <summary>View import exceptions</summary>
              <ul>
                {status.importReport.issues.slice(0, 100).map((issue) => (
                  <li key={issue.remoteId}>
                    <strong>{issue.title || issue.remoteId}</strong>
                    {issue.start
                      ? ` · ${new Date(issue.start).toLocaleDateString('en-AU', { timeZone: data.timezone })}`
                      : ''}
                    : {issue.reason}
                  </li>
                ))}
                {status.importReport.unmatchedPortal.slice(0, 100).map((shift) => (
                  <li key={shift.id}>
                    <strong>{shift.description}</strong> ·{' '}
                    {new Date(shift.start).toLocaleDateString('en-AU', { timeZone: data.timezone })}
                    : No definite Connecteam match; portal request preserved.
                  </li>
                ))}
              </ul>
              <button
                className="secondary-button"
                onClick={() => {
                  const url = URL.createObjectURL(
                    new Blob([JSON.stringify(status.importReport, null, 2)], {
                      type: 'application/json',
                    }),
                  );
                  const link = document.createElement('a');
                  link.href = url;
                  link.download = 'connecteam-import-report.json';
                  link.click();
                  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
                }}
              >
                Download full import report
              </button>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
