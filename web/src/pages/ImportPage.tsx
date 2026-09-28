import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, List, NavBar, NoticeBar, Result, Toast } from 'antd-mobile';
import * as XLSX from 'xlsx';
import { money, post, toFen } from '../api';

const HEADERS = ['商品名称', '条码', '规格', '分类', '参考售价', '备注', '期初数量', '期初成本单价'];

interface Row {
  name: string;
  barcode: string;
  spec: string;
  category: string;
  ref_price: number | null;
  note: string;
  opening_qty: number | null;
  opening_cost: number | null;
  error?: string;
}

function downloadTemplate() {
  const ws = XLSX.utils.aoa_to_sheet([
    HEADERS,
    ['MM 混合坚果', '6953787302145', '1.13kg', '零食', 128, '', 5, 99.9],
    ['百醇 抹茶味', '6901668935144', '6盒装', '零食', 55, '', '', ''],
  ]);
  ws['!cols'] = HEADERS.map(() => ({ wch: 14 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '商品');
  XLSX.writeFile(wb, '商品导入模板.xlsx');
}

function parse(file: ArrayBuffer): Row[] {
  const wb = XLSX.read(file);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false });
  const str = (v: unknown) => String(v ?? '').trim();
  const num = (v: unknown) => (str(v) === '' ? null : Number(str(v).replace(/[¥,，\s]/g, '')));
  return raw
    .map((r) => {
      const qty = num(r['期初数量']);
      const cost = num(r['期初成本单价']);
      const ref = num(r['参考售价']);
      const row: Row = {
        name: str(r['商品名称']),
        barcode: str(r['条码']).replace(/\.0$/, ''),
        spec: str(r['规格']),
        category: str(r['分类']),
        note: str(r['备注']),
        ref_price: ref != null && !isNaN(ref) ? toFen(ref) : null,
        opening_qty: qty,
        opening_cost: cost != null && !isNaN(cost) ? toFen(cost) : null,
      };
      if (!row.name) row.error = '缺少商品名称';
      else if (qty != null && (!Number.isInteger(qty) || qty < 0)) row.error = '期初数量需为整数';
      else if (qty && row.opening_cost == null) row.error = '填了期初数量需要填期初成本单价';
      return row;
    })
    .filter((r) => r.name || r.barcode);
}

export default function ImportPage() {
  const nav = useNavigate();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<{ created: number; updated: number; opening_doc_id: number | null } | null>(null);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      setRows(parse(await f.arrayBuffer()));
    } catch {
      Toast.show('读取 Excel 失败，请用模板格式');
    }
  };

  const errors = rows?.filter((r) => r.error) ?? [];
  const opening = rows?.filter((r) => r.opening_qty) ?? [];

  const submit = async () => {
    setSaving(true);
    try {
      setDone(
        await post('/api/products/import', {
          rows: rows!.map(({ error, ...r }) => ({ ...r, opening_qty: r.opening_qty || null })),
        }),
      );
    } catch (e: any) {
      Toast.show({ content: e.message, icon: 'fail' });
    } finally {
      setSaving(false);
    }
  };

  if (done) {
    return (
      <div className="page">
        <NavBar onBack={() => nav(-1)}>导入商品</NavBar>
        <Result
          status="success"
          title="导入完成"
          description={`新建 ${done.created} 个，更新 ${done.updated} 个${done.opening_doc_id ? '，并生成了期初库存单' : ''}`}
        />
        <div style={{ padding: 16, display: 'grid', gap: 12 }}>
          <Button block color="primary" onClick={() => nav('/products')}>
            查看商品
          </Button>
          {done.opening_doc_id && (
            <Button block onClick={() => nav(`/docs/${done.opening_doc_id}`)}>
              查看期初库存单
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <NavBar onBack={() => nav(-1)}>导入商品</NavBar>
      <NoticeBar
        wrap
        color="info"
        content="按模板填写：条码或名称+规格相同的会更新已有商品。填了「期初数量」和「期初成本单价」的行会生成一张期初库存单（不从任何账户扣钱）。"
      />
      <div className="import-actions">
        <Button onClick={downloadTemplate}>下载模板</Button>
        <label className="adm-button adm-button-primary adm-button-shape-default file-btn">
          选择 Excel 文件
          <input type="file" accept=".xlsx,.xls,.csv" hidden onChange={(e) => onFile(e.target.files?.[0])} />
        </label>
      </div>
      {rows && (
        <>
          <div className="section-title">
            预览 {rows.length} 行{opening.length ? `，${opening.length} 行带期初库存` : ''}
            {errors.length > 0 && <span className="warn-text">{errors.length} 行有问题</span>}
          </div>
          <List>
            {rows.map((r, i) => (
              <List.Item
                key={i}
                description={
                  r.error ? (
                    <span className="warn-text">{r.error}</span>
                  ) : (
                    [r.barcode, r.spec, r.category, r.ref_price != null ? `售价 ${money(r.ref_price)}` : '']
                      .filter(Boolean)
                      .join(' · ')
                  )
                }
                extra={r.opening_qty ? `期初 ${r.opening_qty} × ${money(r.opening_cost)}` : null}
              >
                {r.name || '（无名称）'}
              </List.Item>
            ))}
          </List>
          <div className="submit-bar">
            <Button block color="primary" size="large" disabled={!rows.length || errors.length > 0} loading={saving} onClick={submit}>
              {errors.length ? '请先修正有问题的行' : `确认导入 ${rows.length} 个商品`}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

export { HEADERS };
