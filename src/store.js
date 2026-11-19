import { DatabaseSync } from 'node:sqlite';

export function openStore(filename) {
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      command TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued',
      available_at INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      message TEXT
    );
    CREATE INDEX IF NOT EXISTS jobs_available ON jobs (state, available_at);
  `);

  const enqueue = db.prepare('INSERT INTO jobs (id, command) VALUES (?, ?) ON CONFLICT (id) DO NOTHING');
  const ready = db.prepare(`
    SELECT command, attempts, message
    FROM jobs
    WHERE state = 'queued' AND available_at <= ?
    ORDER BY available_at, rowid
    LIMIT 1
  `);
  const begin = db.prepare('UPDATE jobs SET attempts = attempts + 1 WHERE id = ?');
  const saveMessage = db.prepare('UPDATE jobs SET message = ? WHERE id = ?');
  const finish = db.prepare('UPDATE jobs SET state = ? WHERE id = ?');
  const delay = db.prepare('UPDATE jobs SET available_at = ? WHERE id = ?');

  return {
    enqueue(command) {
      enqueue.run(command.id, JSON.stringify(command));
    },
    next(now) {
      const row = ready.get(now);
      if (!row) return null;
      const command = JSON.parse(row.command);
      begin.run(command.id);
      return { ...command, attempts: row.attempts + 1, message: row.message };
    },
    saveMessage(id, message) {
      saveMessage.run(message, id);
    },
    finish(id, state) {
      finish.run(state, id);
    },
    delay(id, availableAt) {
      delay.run(availableAt, id);
    },
    close() {
      db.close();
    },
  };
}
