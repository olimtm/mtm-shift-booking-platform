import 'dotenv/config';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/db.js';
import { hashPassword } from '../server/auth.js';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string' },
    'participant-ids': { type: 'string' },
    database: { type: 'string' },
    'password-stdin': { type: 'boolean' },
    help: { type: 'boolean' },
  },
  strict: true,
});
if (values.help) {
  console.log(
    'Create an account: npm run create-user -- --email person@example.com --name "Full Name" --role staff|client [--participant-ids p-id,p-id] [--database .local/support.sqlite] [--password-stdin]\nThe password is read without echo from your terminal, from CREATE_USER_PASSWORD, or from stdin with --password-stdin. Never pass passwords as command arguments.',
  );
  process.exit(0);
}
async function passwordInput(): Promise<string> {
  if (process.env.CREATE_USER_PASSWORD) return process.env.CREATE_USER_PASSWORD;
  if (values['password-stdin']) {
    let result = '';
    for await (const chunk of process.stdin) {
      result += String(chunk);
      if (result.length > 1024) throw new Error('Password input is too long.');
    }
    return result.replace(/\r?\n$/, '');
  }
  if (!process.stdin.isTTY)
    throw new Error(
      'Use --password-stdin, a terminal prompt, or CREATE_USER_PASSWORD to supply a password securely.',
    );
  process.stdout.write('Password (hidden): ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const listener = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (text === '\u0003') {
        finish();
        reject(new Error('Cancelled.'));
      } else if (text.includes('\r') || text.includes('\n')) {
        finish();
        resolve(value);
      } else if (text === '\u007f' || text === '\b') value = value.slice(0, -1);
      else if (!/[\u0000-\u001f]/.test(text)) value += text;
    };
    const finish = () => {
      process.stdin.removeListener('data', listener);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    };
    process.stdin.on('data', listener);
  });
}
let store: Store | undefined;
try {
  const email = values.email?.trim().toLowerCase();
  const name = values.name?.trim();
  const role = values.role;
  if (!email || email.length > 254 || !/^\S+@\S+\.\S+$/.test(email))
    throw new Error('Provide a valid --email.');
  if (!name || name.length < 2 || name.length > 150)
    throw new Error('Provide --name (2–150 characters).');
  if (role !== 'staff' && role !== 'client')
    throw new Error('Provide --role staff or --role client.');
  const participantIds = [
    ...new Set(
      (values['participant-ids'] ?? '')
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean),
    ),
  ];
  if (role === 'client' && !participantIds.length)
    throw new Error(
      'Client accounts require --participant-ids for at least one existing participant.',
    );
  store = new Store(values.database ?? process.env.DATABASE_PATH ?? '.local/support.sqlite');
  if (store.meta('demoDatabase'))
    throw new Error(
      'Use a separate production database. Demo accounts are intentionally isolated.',
    );
  if (store.findUser(email))
    throw new Error('This email already exists. Existing accounts are never overwritten.');
  for (const participantId of participantIds)
    if (!store.get('participants', participantId))
      throw new Error(`Participant does not exist: ${participantId}`);
  const password = await passwordInput();
  if (password.length < 12 || password.length > 256)
    throw new Error('Use a password between 12 and 256 characters.');
  const userId = `u-${randomUUID()}`;
  store.transaction(() => {
    store!.putUser({
      id: userId,
      email,
      name,
      role,
      participantIds,
      passwordHash: hashPassword(password),
    });
    if (role === 'staff')
      store!.put('staff', {
        id: userId,
        name,
        initials: name
          .split(/\s+/)
          .slice(0, 2)
          .map((p) => p[0])
          .join('')
          .toUpperCase(),
        color: 'green',
      });
  });
  console.log(`Created ${role} account for ${email}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Could not create account.');
  process.exitCode = 1;
} finally {
  store?.close();
}
