'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useGameStore } from '@/lib/store';
import { AppShell } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export default function RegisterPage() {
  const router = useRouter();
  const setToken = useGameStore(s => s.setToken);
  const setUser = useGameStore(s => s.setUser);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch('/api/account/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, nickname }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || 'Không thể đăng ký');
      }

      const { token, user } = await res.json();
      setToken(token);
      setUser(user);
      router.push('/profile');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AppShell variant="light">
      <div className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col justify-center gap-6 px-4 py-8 safe-top safe-bottom">
        <div className="text-center">
          <span className="text-4xl" aria-hidden="true">🎨</span>
          <h1 className="mt-2 text-3xl font-bold text-foreground">Đấu Trường Nét</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Tạo tài khoản để lưu thành tích và thử thách bạn bè mỗi ngày.
          </p>
        </div>

        <div className="paper-mat rounded-2xl border border-border/60 p-6 shadow-paper">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="email" className="text-sm font-medium text-foreground">
                Email
              </label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                placeholder="ban@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={loading}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="nickname" className="text-sm font-medium text-foreground">
                Biệt danh
              </label>
              <Input
                id="nickname"
                type="text"
                autoComplete="nickname"
                placeholder="Tên hiển thị trong phòng"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                required
                disabled={loading}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="password" className="text-sm font-medium text-foreground">
                Mật khẩu
              </label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                placeholder="Tối thiểu 6 ký tự"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
                disabled={loading}
              />
            </div>
            {error && (
              <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" className="h-12 w-full" disabled={loading}>
              {loading ? 'Đang đăng ký...' : 'Đăng ký'}
            </Button>
          </form>
          <p className="mt-5 text-center text-sm text-muted-foreground">
            Đã có tài khoản?{' '}
            <Link href="/login" className="font-medium text-primary underline-offset-4 hover:underline">
              Đăng nhập
            </Link>
          </p>
        </div>

        <Button asChild variant="outline" className="h-12 w-full">
          <Link href="/">← Về trang chủ</Link>
        </Button>
      </div>
    </AppShell>
  );
}
