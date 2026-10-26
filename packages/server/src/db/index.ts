import { assertTestWrite } from '../core/test-isolation.ts';
/**
 * 数据库连接（使用 Node 24 内置 node:sqlite，零原生依赖）
 *
 * - WAL 模式：读写并发更稳
 * - foreign_keys：外键约束开启，避免脏数据
 * - busy_timeout：多进程/多请求时不直接报 SQLITE_BUSY
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { runMigrations } from './migrate.ts';

export type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, unknown>;

let db: DatabaseSync | null = null;
let dbPath = '';

export function openDatabase(file: string): DatabaseSync {
  assertTestWrite(file);
  if (db) return db;
  mkdirSync(dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  dbPath = file;
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 8000');
  db.exec('PRAGMA synchronous = NORMAL');
  return db;
}

export function getDb(): DatabaseSync {
  if (!db) throw new Error('数据库尚未初始化，请先调用 openDatabase()');
  return db;
}

export function getDbPath(): string {
  return dbPath;
}

export function initDatabase(file: string): DatabaseSync {
  const d = openDatabase(file);
  runMigrations(d);
  return d;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/* ------------------------- 查询助手（位置参数，避免歧义） ------------------------- */

export function all<T = Row>(sql: string, params: SqlValue[] = []): T[] {
  return getDb().prepare(sql).all(...params) as unknown as T[];
}

export function get<T = Row>(sql: string, params: SqlValue[] = []): T | undefined {
  return getDb().prepare(sql).get(...params) as unknown as T | undefined;
}

export function run(sql: string, params: SqlValue[] = []): { changes: number; lastInsertRowid: number } {
  const r = getDb().prepare(sql).run(...params);
  return {
    changes: Number(r.changes),
    lastInsertRowid: Number(r.lastInsertRowid),
  };
}

export function pluck1<T = unknown>(sql: string, params: SqlValue[] = []): T | undefined {
  const row = getDb().prepare(sql).get(...params) as Row | undefined;
  if (!row) return undefined;
  const keys = Object.keys(row);
  return keys.length ? (row[keys[0] as string] as T) : undefined;
}

/** 事务包装：抛错自动回滚 */
let transactionId=0;
export function tx<T>(fn:()=>T):T {
 const d=getDb(),name='wb_tx_'+(++transactionId);
 d.exec('SAVEPOINT '+name);
 try{const result=fn();d.exec('RELEASE '+name);return result;}catch(e){d.exec('ROLLBACK TO '+name);d.exec('RELEASE '+name);throw e;}
}

/** 把 undefined 归一成 null，方便写库 */
export function nz<T>(v: T | undefined | null): T | null {
  return v === undefined || v === null ? null : v;
}
