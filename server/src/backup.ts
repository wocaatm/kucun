import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from './db.ts';

const KEEP = 14;

/** 本地时间 YYYYMMDDHHmm */
function localStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}

/** 数据库快照 + 全部图片打成一个 tar.gz，保留最近 14 份 */
export function createBackup(db: DB, dataDir: string): string {
  const dir = join(dataDir, 'backups');
  mkdirSync(dir, { recursive: true });
  const snap = join(dataDir, 'kucun-snapshot.db');
  rmSync(snap, { force: true });
  db.exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`);
  const file = join(dir, `kucun-${localStamp()}.tar.gz`);
  execFileSync('tar', ['-czf', file, '-C', dataDir, 'kucun-snapshot.db', 'uploads']);
  rmSync(snap, { force: true });
  const all = listBackups(dataDir);
  for (const old of all.slice(KEEP)) rmSync(join(dir, old), { force: true });
  return file;
}

export function listBackups(dataDir: string): string[] {
  const dir = join(dataDir, 'backups');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.tar.gz'))
    .sort()
    .reverse();
}

export function scheduleDailyBackup(db: DB, dataDir: string) {
  const run = () => {
    try {
      const latest = listBackups(dataDir)[0];
      const todayStamp = localStamp().slice(0, 8);
      if (!latest?.includes(`kucun-${todayStamp}`)) createBackup(db, dataDir);
    } catch (e) {
      console.error('backup failed', e);
    }
  };
  setTimeout(run, 60_000);
  setInterval(run, 60 * 60 * 1000).unref();
}
