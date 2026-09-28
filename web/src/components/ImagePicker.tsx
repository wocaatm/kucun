import { useRef, useState } from 'react';
import { ImageViewer, SpinLoading, Toast } from 'antd-mobile';
import { AddOutline, CloseCircleFill } from 'antd-mobile-icons';
import { api, fileUrl, type Upload } from '../api';

/** 压缩到最长边 1600px 的 JPEG；原图另外上传一份留给识别 */
async function compress(file: File, maxSide = 1600, quality = 0.82): Promise<Blob> {
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return file;
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return new Promise((r) => canvas.toBlob((b) => r(b ?? file), 'image/jpeg', quality));
}

export async function uploadImage(file: File, kind: string, note = ''): Promise<Upload> {
  const fd = new FormData();
  fd.append('kind', kind);
  fd.append('note', note);
  fd.append('file', await compress(file), 'image.jpg');
  // 原图太大时也压一下（识别用 2400px 足够），避免手机流量浪费
  if (file.size > 300 * 1024) fd.append('original', file.size > 6 * 1024 * 1024 ? await compress(file, 2400, 0.9) : file, 'orig.jpg');
  const r = await api<{ upload: Upload }>('POST', '/api/uploads', fd);
  return r.upload;
}

interface Props {
  kind: string;
  value: Upload[];
  onChange: (v: Upload[]) => void;
  max?: number;
  /** 上传完成后回调（用于触发识别） */
  onUploaded?: (u: Upload) => void;
  label?: string;
  deletable?: boolean;
}

export default function ImagePicker({ kind, value, onChange, max = 9, onUploaded, label = '添加图片', deletable = true }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(0);

  const pick = async (files: FileList | null) => {
    if (!files?.length) return;
    const list = Array.from(files).slice(0, max - value.length);
    setBusy(list.length);
    let next = [...value];
    for (const f of list) {
      try {
        const u = await uploadImage(f, kind);
        next = [...next, u];
        onChange(next);
        onUploaded?.(u);
      } catch (e: any) {
        Toast.show({ content: e.message ?? '上传失败', icon: 'fail' });
      } finally {
        setBusy((b) => b - 1);
      }
    }
    if (input.current) input.current.value = '';
  };

  return (
    <div className="img-picker">
      {value.map((u, i) => (
        <div className="img-cell" key={u.id}>
          <img
            src={fileUrl(u.id)}
            onClick={() => ImageViewer.Multi.show({ images: value.map((x) => fileUrl(x.id)), defaultIndex: i })}
          />
          {deletable && <CloseCircleFill className="img-del" onClick={() => onChange(value.filter((x) => x.id !== u.id))} />}
        </div>
      ))}
      {busy > 0 && (
        <div className="img-cell img-loading">
          <SpinLoading color="primary" style={{ '--size': '24px' }} />
        </div>
      )}
      {value.length + busy < max && (
        <label className="img-cell img-add">
          <AddOutline fontSize={24} />
          <span>{label}</span>
          <input ref={input} type="file" accept="image/*" multiple={max > 1} hidden onChange={(e) => pick(e.target.files)} />
        </label>
      )}
    </div>
  );
}
