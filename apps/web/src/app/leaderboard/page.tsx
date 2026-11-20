'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/layout/AppShell';
import { PageHeader } from '@/components/layout/PageHeader';
import { api } from '@/lib/api';

const backAction = (
  <Link
    href="/"
    className="inline-flex h-11 items-center rounded-md border border-panel-border/30 bg-arena-800/40 px-3 text-sm font-medium text-on-arena transition-colors hover:bg-arena-800/70"
  >
    ← Về trang chủ
  </Link>
);

type Period = 'daily' | 'weekly' | 'all-time';

interface Entry {
  rank: number;
  playerId: string;
  nickname: string;
  points: number;
}

export default function LeaderboardPage() {
  const [period, setPeriod] = useState<Period>('all-time');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(false);
    api.getLeaderboard(period, 50).then(data => {
      setEntries(data.entries);
      setLoading(false);
    }).catch(() => {
      setError(true);
      setLoading(false);
    });
  }, [period]);

  const medals: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉' };

  return (
    <AppShell variant="arena">
      <PageHeader
        title="Bảng xếp hạng"
        subtitle="Những người chơi xuất sắc nhất"
        actions={backAction}
      />
      <main className="safe-bottom mx-auto max-w-xl space-y-4 px-4 py-6 md:py-8">
        <div className="flex gap-2" role="group" aria-label="Khoảng thời gian xếp hạng">
          {([['daily', 'Hôm nay'], ['weekly', 'Tuần này'], ['all-time', 'Tổng']] as [Period, string][]).map(([p, label]) => (
            <button
              key={p}
              type="button"
              aria-pressed={period === p}
              onClick={() => setPeriod(p)}
              className={`h-11 flex-1 rounded-md px-3 text-sm font-medium transition-colors ${
                period === p
                  ? 'bg-primary text-primary-foreground'
                  : 'border border-panel-border/30 bg-arena-800/40 text-on-arena hover:bg-arena-800/70'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="panel-arena rounded-xl p-4">
          {loading ? (
            <p className="py-8 text-center text-sm text-muted-on-arena">Đang tải bảng xếp hạng...</p>
          ) : error ? (
            <p role="alert" className="py-8 text-center text-sm text-destructive">
              Không thể tải bảng xếp hạng. Vui lòng thử lại sau.
            </p>
          ) : entries.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-on-arena">Chưa có dữ liệu xếp hạng</p>
          ) : (
            <ol className="no-scrollbar space-y-2">
              {entries.map(e => (
                <li
                  key={e.playerId + e.rank}
                  className={`flex items-center justify-between gap-3 rounded-lg p-3 ${
                    e.rank <= 3 ? 'border border-warning/40 bg-warning/10' : 'bg-arena-800/40'
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="score-number w-8 shrink-0 text-center text-xl">
                      {medals[e.rank] ?? `#${e.rank}`}
                    </span>
                    <span className="truncate font-medium text-on-arena">{e.nickname}</span>
                  </div>
                  <span className={`score-number shrink-0 rounded-md px-2 py-1 text-sm font-semibold ${
                    e.rank <= 3 ? 'bg-primary/20 text-on-arena' : 'bg-arena-800/60 text-muted-on-arena'
                  }`}>
                    {e.points} pts
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </main>
    </AppShell>
  );
}
