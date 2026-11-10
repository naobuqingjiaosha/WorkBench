/**
 * 迁移执行器
 *
 * 迁移文件放在 ./migrations 目录，命名 001_xxx.sql / 002_xxx.sql …
 * 已执行的版本记在 schema_migration 表里，重复启动不会重复执行。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_DIR = join(here, 'migrations');

function listMigrations(): { version: string; file: string }[] {
  return readdirSync(MIGRATION_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ version: f.replace(/\.sql$/, ''), file: join(MIGRATION_DIR, f) }));
}

export function runMigrations(db: DatabaseSync): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migration (
    version    TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migration').all() as { version: string }[]).map((r) => r.version),
  );

  const pending = listMigrations().filter(m => !applied.has(m.version));
  const done: string[] = [];
  if (!pending.length) return done;
  let current = '';
  db.exec('BEGIN');
  try {
    for (const m of pending) {
      current = m.version;
      db.exec(readFileSync(m.file, 'utf8'));
      db.prepare('INSERT INTO schema_migration (version) VALUES (?)').run(m.version);
      done.push(m.version);
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* original failure remains authoritative */ }
    throw new Error(`迁移 ${current} 执行失败，本批迁移已回滚：${(e as Error).message}`);
  }

  return done;
}

export function migrationStatus(db: DatabaseSync): { version: string; applied: boolean }[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migration (
    version    TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migration').all() as { version: string }[]).map((r) => r.version),
  );
  return listMigrations().map((m) => ({ version: m.version, applied: applied.has(m.version) }));
}
