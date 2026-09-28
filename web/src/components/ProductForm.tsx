import { useEffect, useState } from 'react';
import { Button, CascadePicker, Form, Image, Input, TextArea, Toast } from 'antd-mobile';
import { RightOutline, ScanningOutline } from 'antd-mobile-icons';
import { api, get, toFen, toYuan, type Product, type Upload } from '../api';
import ImagePicker from './ImagePicker';
import Scanner from './Scanner';

interface Props {
  initial?: Partial<Product>;
  onSaved: (p: Product) => void;
  submitText?: string;
}

export default function ProductForm({ initial, onSaved, submitText = '保存' }: Props) {
  const [form] = Form.useForm();
  const [images, setImages] = useState<Upload[]>(
    initial?.image_upload_id ? [{ id: initial.image_upload_id } as Upload] : [],
  );
  const [scan, setScan] = useState(false);
  const [saving, setSaving] = useState(false);
  const [catOpen, setCatOpen] = useState(false);
  const [catOptions, setCatOptions] = useState<{ label: string; value: string; children?: { label: string; value: string }[] }[]>([]);

  useEffect(() => {
    get<{ items: { name: string; children: { name: string }[] }[] }>('/api/products/categories').then((r) =>
      setCatOptions(
        r.items.map((c) => ({
          label: c.name,
          value: c.name,
          children: c.children.length ? c.children.map((x) => ({ label: x.name, value: `${c.name}/${x.name}` })) : undefined,
        })),
      ),
    );
  }, []);

  const submit = async (v: any) => {
    setSaving(true);
    try {
      const body = {
        name: v.name,
        barcode: v.barcode,
        spec: v.spec,
        category: v.category,
        note: v.note,
        ref_price: v.ref_price ? toFen(v.ref_price) : null,
        image_upload_id: images[0]?.id ?? null,
        brand: v.brand,
        sku_code: v.sku_code,
        image_url: initial?.image_url ?? null,
      };
      const r = initial?.id
        ? await api<{ product: Product }>('PUT', `/api/products/${initial.id}`, body)
        : await api<{ product: Product }>('POST', '/api/products', body);
      Toast.show({ content: '已保存', icon: 'success' });
      onSaved(r.product);
    } catch (e: any) {
      Toast.show({ content: e.message, icon: 'fail' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Form
        form={form}
        layout="horizontal"
        mode="card"
        initialValues={{
          name: initial?.name ?? '',
          barcode: initial?.barcode ?? '',
          spec: initial?.spec ?? '',
          category: initial?.category ?? '',
          note: initial?.note ?? '',
          ref_price: initial?.ref_price != null ? toYuan(initial.ref_price) : '',
          brand: initial?.brand ?? '',
          sku_code: initial?.sku_code ?? '',
        }}
        onFinish={submit}
        footer={
          <Button block type="submit" color="primary" size="large" loading={saving}>
            {submitText}
          </Button>
        }
      >
        <Form.Item name="name" label="名称" rules={[{ required: true, message: '请填写商品名称' }]}>
          <Input placeholder="例如 MM 混合坚果" clearable />
        </Form.Item>
        <Form.Item
          name="barcode"
          label="条码"
          extra={<ScanningOutline fontSize={22} color="var(--adm-color-primary)" onClick={() => setScan(true)} />}
        >
          <Input placeholder="可不填（无码商品）" clearable />
        </Form.Item>
        <Form.Item name="spec" label="规格">
          <Input placeholder="例如 1.13kg / 500粒" clearable />
        </Form.Item>
        <Form.Item
          name="category"
          label="分类"
          extra={<RightOutline color="var(--adm-color-primary)" onClick={() => setCatOpen(true)} />}
        >
          <Input placeholder="点右侧选，或直接填" clearable />
        </Form.Item>
        <Form.Item name="brand" label="品牌">
          <Input placeholder="可不填" clearable />
        </Form.Item>
        <Form.Item name="sku_code" label="货号">
          <Input placeholder="商家货号，可不填" clearable />
        </Form.Item>
        <Form.Item name="ref_price" label="参考售价">
          <Input type="number" inputMode="decimal" placeholder="元" clearable />
        </Form.Item>
        <Form.Item label="图片" description={initial?.image_url && !images.length ? '已有同步来的商品图，也可以上传自己拍的替换' : undefined}>
          <div className="form-images">
            {initial?.image_url && !images.length && <Image src={initial.image_url} width={76} height={76} fit="cover" style={{ borderRadius: 10 }} />}
            <ImagePicker kind="product" value={images} onChange={setImages} max={1} label="商品图" />
          </div>
        </Form.Item>
        <Form.Item name="note" label="备注">
          <TextArea autoSize={{ minRows: 1, maxRows: 4 }} placeholder="可不填" />
        </Form.Item>
      </Form>
      <CascadePicker
        title="选择分类"
        options={catOptions}
        visible={catOpen}
        onClose={() => setCatOpen(false)}
        onConfirm={(v) => {
          const val = (v.filter(Boolean).pop() as string) ?? '';
          if (val) form.setFieldValue('category', val);
        }}
      />
      <Scanner
        visible={scan}
        onClose={() => setScan(false)}
        title="扫描商品条码"
        onDetected={(code) => form.setFieldValue('barcode', code)}
      />
    </>
  );
}
