// 命令行同步奥乐齐商品库：npm run sync:aldi
import { resolve } from 'node:path';
import { openDb } from '../src/db.ts';
import { syncAldi } from '../src/aldi.ts';

const db = openDb(resolve(process.env.DATA_DIR ?? './data'));
const r = await syncAldi(db, null, { onProgress: (m) => console.log(m) });
console.log(
  `完成：${r.categories} 个类目，抓到 ${r.fetched} 个商品，新增 ${r.created}，更新 ${r.updated}，用时 ${(r.ms / 1000).toFixed(1)}s`,
);
