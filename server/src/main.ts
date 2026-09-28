import { resolve } from 'node:path';
import { buildApp } from './app.ts';
import { scheduleDailyBackup } from './backup.ts';

const dataDir = resolve(process.env.DATA_DIR ?? './data');
const webDir = resolve(process.env.WEB_DIR ?? '../web/dist');
const port = Number(process.env.PORT ?? 3100);

const { app, db } = buildApp({ dataDir, webDir });
scheduleDailyBackup(db, dataDir);

const host = process.env.HOST ?? '127.0.0.1';
app.listen({ port, host }).then(() => {
  console.log(`kucun server on http://${host}:${port}  data=${dataDir}`);
});
