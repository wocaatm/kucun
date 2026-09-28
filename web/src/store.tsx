import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { get, post, setUnauthorizedHandler, type Meta, type User } from './api';

interface Session {
  user: User | null;
  meta: Meta | null;
  ready: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshMeta: () => Promise<void>;
}

const Ctx = createContext<Session>(null as unknown as Session);
export const useSession = () => useContext(Ctx);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [ready, setReady] = useState(false);

  const refreshMeta = useCallback(async () => {
    setMeta(await get<Meta>('/api/meta'));
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    get<{ user: User }>('/api/me')
      .then(async (r) => {
        setUser(r.user);
        await refreshMeta();
      })
      .catch(() => setUser(null))
      .finally(() => setReady(true));
  }, [refreshMeta]);

  const login = async (username: string, password: string) => {
    const r = await post<{ user: User }>('/api/auth/login', { username, password });
    setUser(r.user);
    await refreshMeta();
  };

  const logout = async () => {
    await post('/api/auth/logout');
    setUser(null);
  };

  return <Ctx.Provider value={{ user, meta, ready, login, logout, refreshMeta }}>{children}</Ctx.Provider>;
}
