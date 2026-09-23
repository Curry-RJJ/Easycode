/**
 * Session 存储层
 *
 * 两层存储：
 *   - JSONL 文件：会话内容主体（append-only，崩溃安全）
 *   - SQLite：会话索引（快速查询列表、状态）
 *
 * 存储路径：
 *   ~\.easycode\sessions\<id>.jsonl
 *   ~\.easycode\sessions.db
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
import type { EventRecord } from './types.js';

// better-sqlite3 是 CJS 模块，通过 createRequire 在 ESM 中使用
const require = createRequire(import.meta.url);

// ─── 路径配置 ─────────────────────────────────────────────────────────

const HOME_DIR = os.homedir();
const EASYCODE_DIR = path.join(HOME_DIR, '.easycode');
export const SESSIONS_DIR = path.join(EASYCODE_DIR, 'sessions');
const DB_PATH = path.join(EASYCODE_DIR, 'sessions.db');

function ensureDirs(): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// ─── JSONL 操作 ────────────────────────────────────────────────────────

/** 获取 session JSONL 文件路径 */
export function getSessionFilePath(sessionId: string): string {
  return path.join(SESSIONS_DIR, `${sessionId}.jsonl`);
}

/** 追加一条事件到 JSONL（append-only，线程安全） */
export function appendEvent(sessionId: string, event: EventRecord): void {
  ensureDirs();
  const line = JSON.stringify(event) + '\n';
  fs.appendFileSync(getSessionFilePath(sessionId), line, { encoding: 'utf-8', flag: 'a' });
}

/** 读取 session 的所有事件（按 seq 排序） */
export function readEvents(sessionId: string): EventRecord[] {
  const filePath = getSessionFilePath(sessionId);
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim());

  const events: EventRecord[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as EventRecord);
    } catch {
      // 跳过损坏的行（崩溃时可能发生）
    }
  }

  // 按 seq 严格排序（防止乱序写入）
  return events.sort((a, b) => a.seq - b.seq);
}

/** 检查 session JSONL 是否存在 */
export function sessionExists(sessionId: string): boolean {
  return fs.existsSync(getSessionFilePath(sessionId));
}

// ─── SQLite 索引 ───────────────────────────────────────────────────────

export type SessionStatus = 'running' | 'completed' | 'interrupted' | 'error';

export interface SessionEntry {
  id: string;
  created_at: number;
  updated_at: number;
  status: SessionStatus;
  model: string;
  /** 任务首句（截断显示） */
  prompt: string;
}

// 惰性初始化 DB（避免在不需要时创建文件）
let _db: ReturnType<typeof openDb> | null = null;

type Database = {
  exec: (sql: string) => void;
  prepare: (sql: string) => {
    run: (...args: unknown[]) => void;
    get: (...args: unknown[]) => unknown;
    all: (...args: unknown[]) => unknown[];
  };
  close: () => void;
};

function openDb(): Database {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const BetterSqlite3 = require('better-sqlite3') as (path: string) => Database;
  const db = BetterSqlite3(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT    PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      status     TEXT    NOT NULL DEFAULT 'running',
      model      TEXT    NOT NULL DEFAULT '',
      prompt     TEXT    NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions (created_at DESC);
  `);
  return db;
}

function getDb(): Database {
  if (!_db) {
    ensureDirs();
    _db = openDb();
  }
  return _db;
}

/** 创建 session 索引记录 */
export function createSessionEntry(entry: {
  id: string;
  model: string;
  prompt: string;
  status?: SessionStatus;
}): void {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO sessions (id, created_at, updated_at, status, model, prompt)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      entry.id,
      now,
      now,
      entry.status ?? 'running',
      entry.model,
      // 只取前 200 字符用于显示
      entry.prompt.slice(0, 200)
    );
}

/** 更新 session 状态 */
export function updateSessionStatus(id: string, status: SessionStatus): void {
  getDb()
    .prepare(`UPDATE sessions SET status=?, updated_at=? WHERE id=?`)
    .run(status, Date.now(), id);
}

/** 获取所有 session（最新在前） */
export function listSessionEntries(limit = 50): SessionEntry[] {
  return getDb()
    .prepare(`SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as SessionEntry[];
}

/** 获取指定 session */
export function getSessionEntry(id: string): SessionEntry | null {
  return (
    (getDb().prepare(`SELECT * FROM sessions WHERE id=?`).get(id) as SessionEntry | undefined) ??
    null
  );
}
