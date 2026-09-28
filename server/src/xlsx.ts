import { inflateRawSync } from 'node:zlib';

/** 从 zip 里取出若干文件（只支持 stored / deflate，够读 xlsx） */
function unzip(buf: Buffer, wanted: (name: string) => boolean): Map<string, string> {
  // 从尾部找中央目录结束记录
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx 文件');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, string>();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('xlsx 文件已损坏');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!wanted(name)) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    out.set(name, (method === 0 ? raw : inflateRawSync(raw)).toString('utf8'));
  }
  return out;
}

const unescape = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');

/** 一个 <si> / <is> 里所有 <t> 拼起来（富文本会拆成多段） */
const textOf = (xml: string) => unescape([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));

const colIndex = (ref: string) => {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/** 读第一个工作表，返回以表头为键的行（全部是字符串，空单元格为 ''） */
export function readXlsx(buf: Buffer): Record<string, string>[] {
  const files = unzip(buf, (n) => n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const sheetName = [...files.keys()].filter((n) => n.startsWith('xl/worksheets/')).sort()[0];
  if (!sheetName) throw new Error('xlsx 里没有工作表');
  const shared = [...(files.get('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));

  const grid: string[][] = [];
  for (const row of files.get(sheetName)!.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const body = c[2] ?? '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /\bt="(\w+)"/.exec(attrs)?.[1];
      let v = '';
      if (type === 'inlineStr') v = textOf(body);
      else {
        const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
        v = type === 's' ? (shared[Number(raw)] ?? '') : unescape(raw);
      }
      cells[ref ? colIndex(ref) : cells.length] = v;
    }
    grid.push(Array.from(cells, (x) => x ?? ''));
  }
  const [header = [], ...rows] = grid;
  const keys = header.map((h) => h.trim());
  return rows
    .filter((r) => r.some((x) => x.trim()))
    .map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}
