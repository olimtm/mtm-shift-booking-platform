import { DatabaseSync, backup } from 'node:sqlite';
import { chmodSync, closeSync, openSync } from 'node:fs';
import { resolve } from 'node:path';

/** SQLite's online backup API includes committed WAL changes. Never overwrite a backup. */
export async function backupDatabase(source: string, destination: string) {
  if (resolve(source) === resolve(destination)) throw new Error('Choose a different backup path.');
  const database = new DatabaseSync(source, { readOnly: true });
  let check: DatabaseSync | undefined;
  try {
    // Exclusive creation prevents accidentally replacing a database or an existing backup.
    closeSync(openSync(destination, 'wx', 0o600));
    await backup(database, destination);
    chmodSync(destination, 0o600);
    check = new DatabaseSync(destination, { readOnly: true });
    const result = check.prepare('PRAGMA integrity_check').all();
    if (result.length !== 1 || result[0].integrity_check !== 'ok')
      throw new Error('Backup integrity check failed; retain the source database.');
  } finally {
    check?.close();
    database.close();
  }
}
