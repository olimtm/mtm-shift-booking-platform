# Recovery and validation — 6 October 2026 (Sydney)

Both `/workspace/mtm-shift-booking-platform` and its `.local/releases/mtm-support-bookings.zip` were available. The original directory, database files and release archive were left untouched. ZIP integrity validation passed for 49 entries. The archive SHA-256 was `c1c42f5d5f26bd7578ad2604ed61ca99481498027084f6080e6d74be8608df7d`.

The recovered application was copied to a separate working directory, excluding private runtime data and generated files. GitHub already contained a one-line README commit (`775066f`); recovery continues that history rather than replacing it. GitHub is the durable source of application code. Databases, credentials, dependency directories and workspace ZIPs are excluded.

Changes made after recovery:

- Matched Airtable’s exact `Client Portal` select label while preserving Claude’s schema and automation drafts.
- Treated blank support switches as none; Recommended remains explicitly mapped to none until support is approved.
- Added coordinator-managed support worker records and Airtable links without creating privileged login accounts.
- Added an online SQLite backup command and restore verification; moved the runtime TypeScript loader into production dependencies.
- Updated the self-managed Render and WordPress instructions and removed the unused agency handoff from the maintained source.

Validation completed with fictional or temporary records:

- 66 automated API/domain/integration/account/backup tests passed.
- TypeScript checking and production Vite build passed.
- Desktop/mobile browser booking checks passed: login, participant scope, times/preferences, request approval, edit/cancellation review, hidden participants/manual requests, worker roster, repeated RSVP delivery and both 30-minute buffers.
- Desktop/mobile account browser checks passed: initial coordinator setup, invitations, activation, participant grants, reset links/session revocation and disabling access.
- Production dependency audit reported zero known vulnerabilities at verification time.
- Live read-only application schema check returned `ok: true` with no issues. No live records were imported or written.

Deployment remains pending. Render has not been provisioned and no public portal URL exists yet. The Blueprint uses a single paid Node 24 service and a 1 GB persistent SQLite disk; its current plan ID and manual-deploy setting were checked against Render’s Blueprint reference. Configure external backups and validate the live import/round trip before client invitations.

Airtable has an active legacy **1:1 event support request from RSVP** creator. Claude’s three **MTM — …** portal drafts are disabled and still need the repository script, actual portal URL and webhook secret. Preserve them and complete the documented cutover; do not run both request creators. No Airtable automations were modified during recovery.
