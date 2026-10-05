import 'dotenv/config';
import { backupDatabase } from '../server/backup.js';
const source = process.env.DATABASE_PATH;
const destination = process.argv[2];
if (!source || !destination) {
  console.error('Set DATABASE_PATH and run npm run backup -- /absolute/private/path/backup.sqlite');
  process.exitCode = 1;
} else {
  try {
    await backupDatabase(source, destination);
    console.log(
      'Database backup completed and passed its integrity check. Store the backup privately off the application disk.',
    );
  } catch {
    console.error(
      'Backup failed. Check paths, permissions, and that the destination does not exist. Source data was not replaced.',
    );
    process.exitCode = 1;
  }
}
