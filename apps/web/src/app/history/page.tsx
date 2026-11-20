'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/layout/AppShell';
import { PageHeader } from '@/components/layout/PageHeader';

const backAction = (
  <Link
    href="/"
    className="inline-flex h-11 items-center rounded-md border border-panel-border/30 bg-arena-800/40 px-3 text-sm font-medium text-on-arena transition-colors hover:bg-arena-800/70"
  >
    ← Về trang chủ
  </Link>
);

interface MatchSummary {
  id: string;
  roomCode: string;
  startedAt: string;
  endedAt: string | null;
  rankings: Array<{ playerId: string; nickname: string; points: number; rank: number }>;
}

export default function HistoryPage() {
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/matches?limit=30')
      .then(r => r.ok ? r.json() : Promise.reject('Failed to load'))
      .then(d => setMatches(d.matches || []))
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  return (
    <AppShell variant="arena">
      <PageHeader
        title="Lịch sử trận đấu"
        subtitle="Các trận đã kết thúc gần đây"
        actions={backAction}
      />
      <main className="safe-bottom mx-auto max-w-4xl space-y-4 px-4 py-6 md:py-8">
        {loading && (
          <div className="panel-arena rounded-xl p-6 text-center text-sm text-muted-on-arena">
            Đang tải lịch sử trận đấu...
          </div>
        )}

        {error && (
          <div role="alert" className="panel-arena rounded-xl border-danger-on-arena p-6 text-sm text-danger-on-arena">
            Không thể tải lịch sử trận đấu. Vui lòng thử lại sau.
          </div>
        )}

        {!loading && !error && matches.length === 0 && (
          <div className="panel-arena rounded-xl p-8 text-center space-y-2">
            <p className="font-medium text-on-arena">Chưa có trận đấu nào</p>
            <p className="text-sm text-muted-on-arena">Hãy tạo phòng và chơi ngay!</p>
          </div>
        )}

        <div className="grid gap-4">
          {matches.map(m => (
            <section key={m.id} className="panel-arena rounded-xl p-4 md:p-5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="flex items-center gap-2 text-base font-semibold text-on-arena">
                  Trận trong phòng
                  <span className="score-number rounded border border-panel-border/40 px-2 py-0.5 text-sm text-muted-on-arena">
                    {m.roomCode}
                  </span>
                </h2>
                <time className="text-xs text-muted-on-arena" dateTime={m.startedAt}>
                  {new Date(m.startedAt).toLocaleString('vi-VN')}
                </time>
              </div>
              <div className="space-y-1">
                {m.rankings.map(r => (
                  <div key={r.playerId} className="flex items-center justify-between gap-3 rounded-lg px-2 py-2 text-sm odd:bg-arena-800/30">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="score-number w-7 shrink-0 font-bold text-warning">#{r.rank}</span>
                      <span className="truncate text-on-arena">{r.nickname}</span>
                    </div>
                    <span className="score-number shrink-0 font-medium text-on-arena">{r.points} pts</span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </main>
    </AppShell>
  );
}
