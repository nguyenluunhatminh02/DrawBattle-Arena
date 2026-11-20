'use client';

import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useGameStore } from '@/lib/store';
import { AppShell } from '@/components/layout/AppShell';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

interface Profile {
  id: string;
  email: string;
  nickname: string;
  avatar: string | null;
  createdAt: string;
  streak: {
    currentStreak: number;
    longestStreak: number;
    lastPlayedAt: string | null;
  };
  stats: {
    matchesPlayed: number;
    totalScore: number;
  };
}

export default function ProfilePage() {
  const router = useRouter();
  const { token, setToken, setUser } = useGameStore();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!token) {
      router.push('/login');
      return;
    }

    fetch('/api/account/profile', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        if (!res.ok) throw new Error('Không thể tải thông tin cá nhân');
        return res.json();
      })
      .then((data) => {
        setProfile(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [token, router]);

  function handleLogout() {
    setToken(null);
    setUser(null);
    router.push('/');
  }

  async function handleAvatarUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !token) return;

    setActionError(null);
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('avatar', file);

      const res = await fetch('/api/account/avatar', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      if (!res.ok) throw new Error('Không thể cập nhật ảnh đại diện');
      const data = await res.json();
      setProfile(prev => prev ? { ...prev, avatar: data.avatarUrl } : null);
    } catch {
      setActionError('Không thể cập nhật ảnh đại diện. Vui lòng thử lại.');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  }

  async function handleDeleteAvatar() {
    if (!token || !confirm('Xóa ảnh đại diện?')) return;

    setActionError(null);
    try {
      const res = await fetch('/api/account/avatar', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Không thể xóa ảnh đại diện');
      setProfile(prev => prev ? { ...prev, avatar: null } : null);
    } catch {
      setActionError('Không thể xóa ảnh đại diện. Vui lòng thử lại.');
    }
  }

  return (
    <AppShell variant="arena">
      <PageHeader
        title="Hồ sơ của bạn"
        subtitle="Thành tích và chuỗi thử thách hàng ngày"
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/">← Về trang chủ</Link>
          </Button>
        }
      />

      <main className="mx-auto w-full max-w-2xl space-y-5 px-4 py-6 safe-bottom">
        {loading ? (
          <div className="panel-arena rounded-2xl px-6 py-12 text-center shadow-panel">
            <p className="text-muted-on-arena">Đang tải hồ sơ...</p>
          </div>
        ) : error || !profile ? (
          <div className="panel-arena rounded-2xl px-6 py-10 text-center shadow-panel">
            <p role="alert" className="text-destructive">
              {error || 'Không tìm thấy hồ sơ'}
            </p>
            <Button onClick={() => router.push('/login')} className="mt-5 h-12 w-full">
              Đăng nhập
            </Button>
          </div>
        ) : (
          <>
            {actionError && (
              <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-danger-on-arena">
                {actionError}
              </p>
            )}

            {/* Identity: one flat panel, no nested cards */}
            <section className="panel-arena rounded-2xl p-5 shadow-panel">
              <div className="flex flex-wrap items-center gap-4">
                <div className="relative shrink-0">
                  {profile.avatar ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={profile.avatar}
                      alt={`Ảnh đại diện của ${profile.nickname}`}
                      width={80}
                      height={80}
                      className="h-20 w-20 rounded-full object-cover"
                    />
                  ) : (
                    <div className="flex h-20 w-20 items-center justify-center rounded-full bg-primary/20 text-3xl font-bold text-on-arena">
                      {profile.nickname.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={handleAvatarUpload}
                    className="hidden"
                    aria-label="Chọn ảnh đại diện"
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-2xl font-bold text-on-arena">{profile.nickname}</h2>
                  <p className="truncate text-sm text-muted-on-arena">{profile.email}</p>
                  <Badge variant="outline" className="mt-2 border-panel-border/50 text-on-arena">
                    Tham gia từ {new Date(profile.createdAt).toLocaleDateString('vi-VN')}
                  </Badge>
                </div>
                <div className="flex w-full gap-2 sm:w-auto">
                  <Button
                    variant="outline"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    className="h-11 flex-1 sm:flex-none"
                  >
                    {uploading ? 'Đang tải lên...' : 'Đổi ảnh'}
                  </Button>
                  {profile.avatar && (
                    <Button
                      variant="destructive"
                      onClick={handleDeleteAvatar}
                      disabled={uploading}
                      className="h-11 flex-1 sm:flex-none"
                    >
                      Xóa ảnh
                    </Button>
                  )}
                </div>
              </div>

              <div className="mt-5 grid grid-cols-2 gap-3 border-t border-panel-border/30 pt-5">
                <div className="rounded-xl bg-panel/60 px-4 py-3 text-center">
                  <p className="score-number text-3xl font-bold text-on-arena">{profile.stats.matchesPlayed}</p>
                  <p className="mt-1 text-xs text-muted-on-arena">Trận đã chơi</p>
                </div>
                <div className="rounded-xl bg-panel/60 px-4 py-3 text-center">
                  <p className="score-number text-3xl font-bold text-on-arena">{profile.stats.totalScore}</p>
                  <p className="mt-1 text-xs text-muted-on-arena">Tổng điểm</p>
                </div>
              </div>
            </section>

            {/* Daily streak: flat sections inside the same visual language */}
            <section className="panel-arena rounded-2xl p-5 shadow-panel">
              <h2 className="text-lg font-bold text-on-arena">Chuỗi thử thách hàng ngày</h2>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-panel/60 px-4 py-3 text-center">
                  <p className="score-number text-3xl font-bold text-on-arena">{profile.streak.currentStreak}</p>
                  <p className="mt-1 text-xs text-muted-on-arena">Chuỗi hiện tại</p>
                </div>
                <div className="rounded-xl bg-panel/60 px-4 py-3 text-center">
                  <p className="score-number text-3xl font-bold text-on-arena">{profile.streak.longestStreak}</p>
                  <p className="mt-1 text-xs text-muted-on-arena">Chuỗi dài nhất</p>
                </div>
              </div>
              {profile.streak.lastPlayedAt && (
                <p className="mt-4 text-center text-xs text-muted-on-arena">
                  Lần chơi gần nhất: {new Date(profile.streak.lastPlayedAt).toLocaleDateString('vi-VN')}
                </p>
              )}
            </section>

            <div className="grid gap-3 sm:grid-cols-2">
              <Button onClick={() => router.push('/daily')} className="h-12">
                Chơi thử thách hàng ngày
              </Button>
              <Button onClick={() => router.push('/leaderboard')} variant="outline" className="h-12">
                Xem bảng xếp hạng
              </Button>
            </div>

            <Button onClick={handleLogout} variant="ghost" className="h-11 w-full text-muted-on-arena hover:text-on-arena">
              Đăng xuất
            </Button>
          </>
        )}
      </main>
    </AppShell>
  );
}
