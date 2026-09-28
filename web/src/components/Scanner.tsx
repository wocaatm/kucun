import { useEffect, useRef, useState } from 'react';
import { Button, Input, Popup, Toast } from 'antd-mobile';
import { BarcodeDetector, prepareZXingModule } from 'barcode-detector/ponyfill';

// 识别库的 wasm 放在自己站点下，不依赖外部 CDN
prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? '/zxing_reader.wasm' : prefix + path),
  },
});

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code'] as const;

interface Props {
  visible: boolean;
  onClose: () => void;
  /** 返回 false 表示本次扫码不算数（例如用户取消了新建） */
  onDetected: (code: string) => void | Promise<void>;
  /** 连续扫码：扫到后不关闭 */
  continuous?: boolean;
  title?: string;
  hint?: string;
}

export default function Scanner({ visible, onClose, onDetected, continuous, title = '扫码', hint }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');
  const [manual, setManual] = useState('');
  const [last, setLast] = useState<{ code: string; n: number } | null>(null);
  const busy = useRef(false);
  const recent = useRef<{ code: string; at: number }>({ code: '', at: 0 });
  const cb = useRef(onDetected);
  cb.current = onDetected;

  const handle = async (code: string) => {
    if (busy.current) return;
    busy.current = true;
    try {
      navigator.vibrate?.(60);
      await cb.current(code);
      setLast((l) => (l?.code === code ? { code, n: l.n + 1 } : { code, n: 1 }));
      if (!continuous) onClose();
    } finally {
      busy.current = false;
    }
  };

  useEffect(() => {
    if (!visible) return;
    setError('');
    setLast(null);
    let stream: MediaStream | null = null;
    let timer = 0;
    let stopped = false;
    const detector = new BarcodeDetector({ formats: [...FORMATS] });

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (stopped) return stream.getTracks().forEach((t) => t.stop());
        const v = videoRef.current!;
        v.srcObject = stream;
        await v.play();
        const tick = async () => {
          if (stopped) return;
          if (!busy.current && v.readyState >= 2) {
            try {
              const codes = await detector.detect(v);
              const code = codes[0]?.rawValue;
              const now = Date.now();
              // 同一个码 1.5 秒内只算一次，避免镜头停留时重复计数
              if (code && !(recent.current.code === code && now - recent.current.at < 1500)) {
                recent.current = { code, at: now };
                await handle(code);
              } else if (code) {
                recent.current.at = now;
              }
            } catch {
              /* 单帧识别失败忽略 */
            }
          }
          timer = window.setTimeout(tick, 200);
        };
        tick();
      } catch (e) {
        setError(
          window.isSecureContext ? '无法打开摄像头，请允许相机权限，或在下方手动输入条码' : '需要 HTTPS 才能使用摄像头，可在下方手动输入条码',
        );
      }
    })();

    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const submitManual = async () => {
    const code = manual.trim();
    if (!code) return void Toast.show('请输入条码');
    setManual('');
    await handle(code);
  };

  return (
    <Popup visible={visible} onMaskClick={onClose} position="bottom" bodyStyle={{ height: '100%' }} destroyOnClose>
      <div className="scanner">
        <div className="scanner-head">
          <span>{title}</span>
          <Button size="small" color="primary" fill="none" onClick={onClose}>
            {continuous ? '完成' : '关闭'}
          </Button>
        </div>
        <div className="scanner-view">
          <video ref={videoRef} playsInline muted />
          <div className="scanner-frame" />
          {error && <div className="scanner-error">{error}</div>}
          {last && (
            <div className="scanner-last">
              已扫：{last.code}
              {last.n > 1 ? ` ×${last.n}` : ''}
            </div>
          )}
        </div>
        {hint && <div className="scanner-hint">{hint}</div>}
        <div className="scanner-manual">
          <Input placeholder="手动输入条码" value={manual} onChange={setManual} onEnterPress={submitManual} type="text" clearable />
          <Button color="primary" onClick={submitManual}>
            确定
          </Button>
        </div>
      </div>
    </Popup>
  );
}
