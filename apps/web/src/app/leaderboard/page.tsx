'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';

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

  useEffect(() => {
    setLoading(true);
    api.getLeaderboard(period, 50).then(data => {
      setEntries(data.entries);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [period]);

  const medals: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉' };

  return (
    <main className="min-h-screen bg-gradient-to-br from-yellow-50 to-orange-50 p-4">
      <div className="max-w-md mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Bảng xếp hạng</h1>
          <Link href="/">
            <Button variant="outline" size="sm">← Về</Button>
          </Link>
        </div>

        <div className="flex gap-2">
          {([['daily', 'Hôm nay'], ['weekly', 'Tuần này'], ['all-time', 'Tổng']] as [Period, string][]).map(([p, label]) => (
            <Button
              key={p}
              variant={period === p ? 'default' : 'outline'}
              size="sm"
              onClick={() => setPeriod(p)}
              className="flex-1"
            >
              {label}
            </Button>
          ))}
        </div>

        <Card>
          <CardContent className="pt-4">
            {loading ? (
              <p className="text-center text-muted-foreground py-8">Đang tải...</p>
            ) : entries.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">Chưa có dữ liệu xếp hạng</p>
            ) : (
              <div className="space-y-2">
                {entries.map(e => (
                  <div
                    key={e.playerId + e.rank}
                    className={`flex items-center justify-between p-3 rounded-lg ${
                      e.rank <= 3 ? 'bg-gradient-to-r from-yellow-100 to-yellow-50 border border-yellow-200' : 'bg-secondary/50'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-xl w-8 text-center">
                        {medals[e.rank] ?? `#${e.rank}`}
                      </span>
                      <span className="font-medium">{e.nickname}</span>
                    </div>
                    <Badge variant={e.rank <= 3 ? 'default' : 'secondary'}>
                      {e.points} pts
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
