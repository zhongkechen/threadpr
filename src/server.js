import { createPrivateKey } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { createGitHub } from './github.js';
import { openStore } from './store.js';
import { createWebhook } from './webhook.js';
import { drainJobs } from './worker.js';

const appId = process.env.THREADPR_APP_ID;
const appSlug = process.env.THREADPR_APP_SLUG ?? 'threadpr';
const privateKeyPath = process.env.THREADPR_PRIVATE_KEY_PATH;
const secret = process.env.THREADPR_WEBHOOK_SECRET;
const dbPath = process.env.THREADPR_DB_PATH ?? './data/threadpr.sqlite';
const port = Number(process.env.PORT ?? 3000);

if (!/^\d+$/u.test(appId ?? '') || !/^[a-z0-9-]+$/u.test(appSlug) || !privateKeyPath || !secret) {
  throw new Error('Set THREADPR_APP_ID, THREADPR_PRIVATE_KEY_PATH and THREADPR_WEBHOOK_SECRET. Use the GitHub App slug for THREADPR_APP_SLUG.');
}
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Set a valid PORT.');

const privateKey = createPrivateKey(readFileSync(privateKeyPath));
if (privateKey.asymmetricKeyType !== 'rsa') throw new Error('Use the RSA private key issued by GitHub.');

if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { mode: 0o700, recursive: true });
const store = openStore(dbPath);
const github = createGitHub({ appId, privateKey });

let busy;
let stopping = false;
function wake() {
  if (busy || stopping) return;
  busy = drainJobs({ store, github, botLogin: `${appSlug}[bot]` })
    .catch((error) => console.error('ThreadPR queue error', error.name))
    .finally(() => { busy = undefined; });
}

const server = createServer(
  { headersTimeout: 5000, requestTimeout: 15_000 },
  createWebhook({ secret, enqueue: store.enqueue, notify: wake }),
);
const timer = setInterval(wake, 1000);
server.listen(port, process.env.HOST ?? '127.0.0.1', () => {
  console.log(`ThreadPR is listening on port ${server.address().port}`);
  wake();
});

async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  await new Promise((resolve) => server.close(resolve));
  await busy;
  store.close();
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);
