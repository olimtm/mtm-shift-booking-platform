# Database backup and recovery

Render must run one application instance with `DATABASE_PATH=/var/data/mtm.sqlite` and its persistent disk mounted at `/var/data`. SQLite WAL mode and the persistent disk retain accounts, sessions, participant grants, bookings, RSVP deduplication and pending Airtable writes across restarts. Do not use the ephemeral application directory for production data or scale this SQLite deployment to multiple instances.

From the service shell, create a uniquely named private backup:

```sh
npm run backup -- /var/data/mtm-backup-2026-10-06.sqlite
```

Choose a new filename for each backup. The command uses SQLite’s online backup API, including committed WAL changes, then runs `PRAGMA integrity_check`. It refuses to overwrite an existing file and restricts file access to its owner. Never copy just the main database file while WAL mode is active.

Transfer verified backups to private storage outside the service disk with restricted access and retention appropriate for participant information. A backup on the same disk is only a staging copy. The repository does not configure a backup destination or a recurring transfer; finish that setup before live clients use the portal. Backups contain password hashes, sessions and participant data and must never be committed to GitHub or uploaded as public artifacts.

To test recovery, restore a backup into a **new** private database path in an isolated instance with outgoing Airtable sync disabled. Run its integrity check, verify account grants, shift counts and pending changes, and exercise a test login. Keep the current database untouched. For a real recovery, stop the original service, preserve its database/WAL files, restore to a fresh path, then point `DATABASE_PATH` at it. Never restore over a running database or leave stale WAL/SHM files beside a replaced main file. Reconcile any records changed since the backup before enabling sync, because restoring also restores the durable retry queue and sessions.

The automated recovery test keeps the source database open, backs it up, opens the restored database, and verifies users, explicit participant grants, sessions, bookings and queued Airtable writes. It also checks that an existing destination and the source cannot be overwritten. This verifies application recovery mechanics; it does not establish that an external backup schedule is running.
