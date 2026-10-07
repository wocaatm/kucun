import type { DB } from './db.ts';
import { log } from './db.ts';
import { newToken } from './auth.ts';
import { BizError } from './docs.ts';

/**
 * 淘宝插件（装在店主浏览器里的 Chrome 扩展）：用店主的千牛登录态导出订单报表、拉商品 SKU，上传到这里。
 * 插件用连接码（Bearer token）鉴权，按连接码生成人的身份写入；每分钟来领一次任务。
 */

export const TASK_KINDS = ['sync_orders', 'sync_skus'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export function migrateAgent(db: DB) {
  db.exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_tasks (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | failed
    message TEXT NOT NULL DEFAULT '',
    created_by INTEGER,                      -- NULL = 插件自己按时发起的
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    started_at TEXT,
    finished_at TEXT
  )`);
}

const kvGet = (db: DB, key: string) => (db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
const kvSet = (db: DB, key: string, value: string) =>
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

/** 生成（或重置）连接码；旧码立即失效 */
export function resetToken(db: DB, userId: number): string {
  const token = `kc_${newToken()}`;
  kvSet(db, 'agent_token', token);
  kvSet(db, 'agent_user_id', String(userId));
  log(db, userId, 'agent_token_reset');
  return token;
}

/** 按连接码找到插件代表的用户；同时记下心跳 */
export function agentUser(db: DB, token: string | undefined) {
  const want = kvGet(db, 'agent_token');
  if (!want || !token || token !== want) return null;
  kvSet(db, 'agent_last_seen', new Date().toISOString());
  const uid = Number(kvGet(db, 'agent_user_id'));
  return (db.prepare('SELECT id, username, name FROM users WHERE id = ?').get(uid) as { id: number; username: string; name: string } | undefined) ?? null;
}

export function agentStatus(db: DB) {
  return {
    token: kvGet(db, 'agent_token'),
    last_seen: kvGet(db, 'agent_last_seen'),
    /** 同步后还没确认的订单数：有就不让再同步 */
    reviews: (db.prepare('SELECT COUNT(*) n FROM taobao_reviews WHERE confirmed_at IS NULL').get() as { n: number }).n,
    tasks: db
      .prepare(
        `SELECT t.*, u.name AS created_by_name FROM agent_tasks t LEFT JOIN users u ON u.id = t.created_by ORDER BY t.id DESC LIMIT 20`,
      )
      .all(),
  };
}

export function createTask(db: DB, userId: number | null, kind: string): number {
  if (!TASK_KINDS.includes(kind as TaskKind)) throw new BizError('未知任务');
  // 同类任务还没做完就不重复排
  const open = db.prepare("SELECT id FROM agent_tasks WHERE kind = ? AND status IN ('pending', 'running')").get(kind) as { id: number } | undefined;
  if (open) return open.id;
  if (kind === 'sync_orders') {
    // 同 taobao.pendingReviews（不引 taobao.ts，避免和 db.ts 循环引用）
    const n = (db.prepare('SELECT COUNT(*) n FROM taobao_reviews WHERE confirmed_at IS NULL').get() as { n: number }).n;
    if (n) throw new BizError(`上次同步还有 ${n} 笔订单没确认，确认完再同步`);
  }
  const id = Number(db.prepare('INSERT INTO agent_tasks (kind, created_by) VALUES (?, ?)').run(kind, userId).lastInsertRowid);
  log(db, userId, 'agent_task', `task:${id}`, { kind });
  return id;
}

/** 插件来领任务：把最早的待办标为进行中。进行中超过 1 小时没回音的当失败，允许重排 */
export function nextTask(db: DB) {
  db.prepare(
    `UPDATE agent_tasks SET status = 'failed', message = '插件超时没回音', finished_at = datetime('now', 'localtime')
     WHERE status = 'running' AND started_at < datetime('now', 'localtime', '-1 hour')`,
  ).run();
  const t = db.prepare("SELECT id, kind FROM agent_tasks WHERE status = 'pending' ORDER BY id LIMIT 1").get() as { id: number; kind: string } | undefined;
  if (!t) return null;
  db.prepare("UPDATE agent_tasks SET status = 'running', started_at = datetime('now', 'localtime') WHERE id = ?").run(t.id);
  return t;
}

/** 插件自己按时发起的任务：直接记成进行中 */
export function startOwnTask(db: DB, kind: string) {
  let id: number;
  try {
    id = createTask(db, null, kind);
  } catch (e) {
    // 有没确认的订单：自动同步跳过，任务列表里留一笔说明
    if (e instanceof BizError)
      db.prepare("INSERT INTO agent_tasks (kind, status, message, finished_at) VALUES (?, 'failed', ?, datetime('now', 'localtime'))").run(
        kind,
        `自动同步跳过：${e.message}`,
      );
    throw e;
  }
  db.prepare("UPDATE agent_tasks SET status = 'running', started_at = COALESCE(started_at, datetime('now', 'localtime')) WHERE id = ?").run(id);
  return { id, kind };
}

export function finishTask(db: DB, id: number, ok: boolean, message: string) {
  db.prepare("UPDATE agent_tasks SET status = ?, message = ?, finished_at = datetime('now', 'localtime') WHERE id = ?").run(
    ok ? 'done' : 'failed',
    message.slice(0, 1000),
    id,
  );
}
