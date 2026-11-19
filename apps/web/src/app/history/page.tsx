'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

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
    <main className="min-h-screen p-4 md:p-8 bg-gradient-to-br from-purple-50 to-blue-50">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold text-primary">Lịch sử trận đấu</h1>
            <p className="text-muted-foreground mt-1">Các trận đã kết thúc gần đây</p>
          </div>
          <Link href="/">
            <Button variant="outline">← Về trang chủ</Button>
          </Link>
        </div>

        {loading && (
          <Card>
            <CardContent className="pt-6 text-center text-muted-foreground">Đang tải...</CardContent>
          </Card>
        )}

        {error && (
          <Card className="border-destructive">
            <CardContent className="pt-6 text-destructive">{error}</CardContent>
          </Card>
        )}

        {!loading && !error && matches.length === 0 && (
          <Card>
            <CardContent className="pt-6 text-center text-muted-foreground">
              Chưa có trận đấu nào. Hãy tạo phòng và chơi!
            </CardContent>
          </Card>
        )}

        <div className="grid gap-4">
          {matches.map(m => (
            <Card key={m.id}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Trận trong phòng <Badge variant="outline">{m.roomCode}</Badge></CardTitle>
                  <span className="text-xs text-muted-foreground">
                    {new Date(m.startedAt).toLocaleString('vi-VN')}
                  </span>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-1">
                  {m.rankings.map(r => (
                    <div key={r.playerId} className="flex items-center justify-between text-sm py-1">
                      <div className="flex items-center gap-3">
                        <span className="font-bold text-primary w-6">#{r.rank}</span>
                        <span>{r.nickname}</span>
                      </div>
                      <span className="font-medium">{r.points} pts</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </main>
  );
}
