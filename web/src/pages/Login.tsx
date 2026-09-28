import { useState } from 'react';
import { Button, Form, Input, Toast } from 'antd-mobile';
import { useSession } from '../store';

export default function Login() {
  const { login } = useSession();
  const [loading, setLoading] = useState(false);
  return (
    <div className="login">
      <div className="login-brand">
        <img src="/icon.svg" width={64} height={64} />
        <h1>小库存</h1>
        <p>进货 · 卖货 · 记账，一目了然</p>
      </div>
      <Form
        mode="card"
        onFinish={async (v) => {
          setLoading(true);
          try {
            await login(v.username, v.password);
          } catch (e: any) {
            Toast.show({ content: e.message, icon: 'fail' });
          } finally {
            setLoading(false);
          }
        }}
        footer={
          <Button block type="submit" color="primary" size="large" loading={loading}>
            登录
          </Button>
        }
      >
        <Form.Item name="username" label="账号" rules={[{ required: true, message: '请输入账号' }]}>
          <Input placeholder="lq / lc / yhh / xrf" autoComplete="username" autoCapitalize="off" />
        </Form.Item>
        <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
          <Input type="password" placeholder="密码" autoComplete="current-password" />
        </Form.Item>
      </Form>
    </div>
  );
}
