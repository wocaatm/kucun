import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Button, Form, Input, NavBar, TextArea, Toast } from 'antd-mobile';
import dayjs from 'dayjs';
import { post, toFen, toYuan, type Upload } from '../api';
import { useSession } from '../store';
import ImagePicker from '../components/ImagePicker';
import { AccountField, ChipField, DateField } from '../components/fields';

const TITLES: Record<string, string> = {
  expense: '记一笔支出',
  income: '记一笔收入',
  transfer: '转账 / 报销',
};

export default function MoneyDocPage() {
  const { type = 'expense' } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { meta, refreshMeta } = useSession();

  const [date, setDate] = useState(dayjs().format('YYYY-MM-DD'));
  const [amount, setAmount] = useState(params.get('amount') ? toYuan(Number(params.get('amount'))) : '');
  const [category, setCategory] = useState('');
  const [accountId, setAccountId] = useState<number | undefined>(Number(params.get('from')) || undefined);
  const [toAccountId, setToAccountId] = useState<number | undefined>(Number(params.get('to')) || undefined);
  const [note, setNote] = useState(params.get('note') ?? '');
  const [images, setImages] = useState<Upload[]>([]);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const fen = toFen(amount || 0);
    if (!(fen > 0)) return void Toast.show('请填写金额');
    if ((type === 'expense' || type === 'income') && !category) return void Toast.show('请选择分类');
    if (!accountId) return void Toast.show(type === 'transfer' ? '请选择转出账户' : '请选择账户');
    if (type === 'transfer' && !toAccountId) return void Toast.show('请选择转入账户');
    setSaving(true);
    try {
      const body = { type, amount: fen, category, account_id: accountId, to_account_id: toAccountId, note, doc_date: date };
      const r = await post('/api/docs', { ...body, upload_ids: images.map((i) => i.id) });
      Toast.show({ content: '已记录', icon: 'success' });
      refreshMeta();
      nav(`/docs/${r.doc.id}`, { replace: true });
    } catch (e: any) {
      Toast.show({ content: e.message, icon: 'fail' });
    } finally {
      setSaving(false);
    }
  };

  const accountLabel =
    type === 'expense' ? '谁付的钱' : type === 'income' ? '钱进了谁的账户' : '从哪个账户转出';

  return (
    <div className="page">
      <NavBar onBack={() => nav(-1)}>{TITLES[type]}</NavBar>
      <div className="amount-hero">
        <span>¥</span>
        <Input
          type="number"
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChange={setAmount}
          autoFocus={!amount}
          className="amount-input"
        />
      </div>
      <Form layout="horizontal" mode="card">
        {(type === 'expense' || type === 'income') && (
          <Form.Item label="分类" layout="vertical">
            <ChipField
              options={(type === 'expense' ? meta?.expense_categories : meta?.income_categories) ?? []}
              value={category}
              onChange={setCategory}
            />
          </Form.Item>
        )}
        <Form.Item label={accountLabel} layout="vertical">
          <AccountField value={accountId} onChange={setAccountId} showBalance={type === 'transfer'} />
        </Form.Item>
        {type === 'transfer' && (
          <Form.Item label="转入哪个账户" layout="vertical" description="报销：公共资金 → 垫付人；上交代收款：个人 → 公共资金">
            <AccountField value={toAccountId} onChange={setToAccountId} exclude={accountId} showBalance />
          </Form.Item>
        )}
        <Form.Item label="日期">
          <DateField value={date} onChange={setDate} />
        </Form.Item>
        <Form.Item label="备注">
          <TextArea value={note} onChange={setNote} autoSize={{ minRows: 2, maxRows: 5 }} placeholder="这笔钱花在哪 / 从哪来" />
        </Form.Item>
        <Form.Item label="照片" layout="vertical">
          <ImagePicker kind="expense" value={images} onChange={setImages} label="拍照" />
        </Form.Item>
      </Form>
      <div className="submit-bar">
        <Button color="primary" size="large" block loading={saving} onClick={submit}>
          保存
        </Button>
      </div>
    </div>
  );
}
