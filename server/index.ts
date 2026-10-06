import 'dotenv/config';
import express from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from './app.js';

const { app, drainOutbox, refreshParticipantActivity, close } = createApp();
const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT must be a valid port number.');
const dist = resolve('dist');
if (existsSync(dist)) {
  app.use(express.static(dist, { index: false }));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
}
const server = app.listen(port, '0.0.0.0', (error?: Error) => {
  if (error) {
    console.error(
      `Could not start support portal API on port ${port}: ${error.name}. Check whether the port is already in use.`,
    );
    close();
    process.exit(1);
  }
  console.log(`Support portal API listening on port ${port}.`);
});
const worker = setInterval(() => {
  void refreshParticipantActivity().catch(() => {});
  void drainOutbox().catch(() =>
    console.error('Airtable sync worker failed; queued changes are retained.'),
  );
}, 30_000);
worker.unref();
void refreshParticipantActivity().catch(() => {});
function stop() {
  clearInterval(worker);
  server.close(() => {
    close();
    process.exit(0);
  });
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
