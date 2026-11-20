'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AppShell } from '@/components/layout/AppShell';
import { PageHeader } from '@/components/layout/PageHeader';
import { useGameStore } from '@/lib/store';

export default function DailyChallengePage() {
  const router = useRouter();
  const player = useGameStore(s => s.player);
  const [daily, setDaily] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [answer, setAnswer] = useState('');
  const [result, setResult] = useState<{ correct: boolean } | null>(null);
  const [guessing, setGuessing] = useState(false);

  useEffect(() => {
    if (!player) {
      router.push('/');
      return;
    }
    fetch('/api/daily/today', {
      headers: { Authorization: `Bearer ${player.token}` },
    })
      .then(r => r.json())
      .then(data => {
        setDaily(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [player, router]);

  async function handleGuess() {
    if (!answer.trim() || !daily || guessing) return;
    setGuessing(true);
    try {
      const res = await fetch('/api/daily/submit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${player!.token}`,
        },
        body: JSON.stringify({ challengeId: daily.id, answer: answer.trim() }),
      });
      if (res.ok) {
        const data = await res.json();
        setResult({ correct: data.correct });
        if (data.correct) setAnswer('');
      }
    } catch {}
    setGuessing(false);
  }

  if (!player) return null;

  const backAction = (
    <Link
      href="/"
      className="inline-flex h-11 items-center rounded-md border border-panel-border/30 bg-arena-800/40 px-3 text-sm font-medium text-on-arena transition-colors hover:bg-arena-800/70"
    >
      ← Về trang chủ
    </Link>
  );

  if (loading) {
    return (
      <AppShell variant="arena">
        <PageHeader title="Thử thách hàng ngày" actions={backAction} />
        <main className="mx-auto flex min-h-[70dvh] max-w-6xl items-center justify-center px-4 py-8">
          <p className="text-muted-on-arena">Đang tải thử thách hàng ngày...</p>
        </main>
      </AppShell>
    );
  }

  if (!daily) {
    return (
      <AppShell variant="arena">
        <PageHeader title="Thử thách hàng ngày" actions={backAction} />
        <main className="mx-auto flex min-h-[70dvh] max-w-md items-center justify-center px-4 py-8">
          <div className="panel-arena w-full space-y-4 rounded-xl p-6 text-center">
            <h2 className="text-xl font-bold text-on-arena">Thử thách hàng ngày không khả dụng</h2>
            <p className="text-sm text-muted-on-arena">Hãy thử lại sau hoặc quay về trang chủ.</p>
            <div className="flex justify-center">{backAction}</div>
          </div>
        </main>
      </AppShell>
    );
  }

  const alreadySolved = daily.userAttempt?.correct;

  return (
    <AppShell variant="arena">
      <PageHeader
        title="Thử thách hàng ngày"
        subtitle="Đoán từ của ngày hôm nay"
        actions={backAction}
      />
      <main className="safe-bottom mx-auto max-w-2xl space-y-4 px-4 py-6 md:py-8">
        <div className="panel-arena space-y-5 rounded-xl p-5 text-center">
          <div className="text-5xl">🎯</div>
          <div className="space-y-1">
            <h2 className="text-2xl font-bold text-on-arena">Thử thách hàng ngày</h2>
            <p className="text-sm text-muted-on-arena">
              Chủ đề: <strong className="text-on-arena">{daily.word?.category?.name || 'Hỗn hợp'}</strong>
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg bg-arena-800/40 p-3">
              <p className="score-number text-2xl font-bold text-on-arena">{daily.stats?.totalAttempts || 0}</p>
              <p className="text-xs text-muted-on-arena">Lượt đoán</p>
            </div>
            <div className="rounded-lg bg-arena-800/40 p-3">
              <p className="score-number text-2xl font-bold text-success">{daily.stats?.successRate?.toFixed(0) || 0}%</p>
              <p className="text-xs text-muted-on-arena">Tỷ lệ đúng</p>
            </div>
          </div>
        </div>

        {alreadySolved ? (
          <div className="panel-arena space-y-4 rounded-xl p-5 text-center">
            <span className="inline-flex rounded-md bg-success/20 px-4 py-1.5 text-base font-semibold text-success">
              Bạn đã đoán đúng!
            </span>
            <p className="score-number text-2xl font-bold text-on-arena">{daily.word.canonical}</p>
            <div className="flex justify-center">{backAction}</div>
          </div>
        ) : (
          <form
            className="panel-arena space-y-3 rounded-xl p-5"
            onSubmit={e => {
              e.preventDefault();
              handleGuess();
            }}
          >
            <p className="text-center font-medium text-on-arena">Bạn đoán đây là gì?</p>
            {result && !result.correct && (
              <p role="status" className="text-center text-sm text-destructive">Sai rồi! Thử lại nào.</p>
            )}
            <div className="flex gap-2">
              <Input
                value={answer}
                onChange={e => setAnswer(e.target.value)}
                placeholder="Nhập đáp án..."
                disabled={guessing}
              />
              <Button type="submit" className="min-w-[72px]" disabled={!answer.trim() || guessing}>
                Đoán
              </Button>
            </div>
          </form>
        )}

        <div className="flex flex-wrap gap-2 justify-center">
          {backAction}
          <Link
            href="/leaderboard"
            className="inline-flex h-11 items-center rounded-md border border-panel-border/30 bg-arena-800/40 px-3 text-sm font-medium text-on-arena transition-colors hover:bg-arena-800/70"
          >
            Bảng xếp hạng
          </Link>
        </div>
      </main>
    </AppShell>
  );
}
