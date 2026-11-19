'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { useGameStore } from '@/lib/store';
import { api } from '@/lib/api';

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

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-muted-foreground">Loading daily challenge...</p>
      </div>
    );
  }

  if (!daily) {
    return (
      <main className="min-h-screen flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center space-y-4">
            <h2 className="text-2xl font-bold">Daily Challenge Unavailable</h2>
            <Link href="/"><Button variant="outline">← Home</Button></Link>
          </CardContent>
        </Card>
      </main>
    );
  }

  const alreadySolved = daily.userAttempt?.correct;

  return (
    <main className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-orange-50 to-pink-50">
      <div className="w-full max-w-lg space-y-6">
        <Card>
          <CardContent className="pt-8 pb-8 space-y-6 text-center">
            <div className="text-5xl">🎯</div>
            <h1 className="text-2xl font-bold">Thử thách hàng ngày</h1>
            <p className="text-muted-foreground">
              Đoán từ của ngày hôm nay! Chủ đề: <strong>{daily.word?.category?.name || 'Hỗn hợp'}</strong>
            </p>
            <div className="grid grid-cols-2 gap-4">
              <div className="p-3 bg-secondary rounded-lg">
                <p className="text-2xl font-bold text-primary">{daily.stats?.totalAttempts || 0}</p>
                <p className="text-xs text-muted-foreground">Lượt đoán</p>
              </div>
              <div className="p-3 bg-secondary rounded-lg">
                <p className="text-2xl font-bold text-green-600">{daily.stats?.successRate?.toFixed(0) || 0}%</p>
                <p className="text-xs text-muted-foreground">Tỷ lệ đúng</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {alreadySolved ? (
          <Card>
            <CardContent className="pt-6 text-center space-y-4">
              <Badge className="bg-green-500 text-white text-lg px-4 py-1">Bạn đã đoán đúng!</Badge>
              <p className="text-2xl font-bold text-primary">{daily.word.canonical}</p>
              <Link href="/"><Button variant="outline" className="w-full">← Home</Button></Link>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="pt-6 space-y-3">
              <p className="text-center font-medium">Bạn đoán đây là gì?</p>
              {result && !result.correct && (
                <p className="text-center text-sm text-destructive">Sai rồi! Thử lại nào.</p>
              )}
              <div className="flex gap-2">
                <Input
                  value={answer}
                  onChange={e => setAnswer(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleGuess()}
                  placeholder="Nhập đáp án..."
                  disabled={guessing}
                />
                <Button onClick={handleGuess} disabled={!answer.trim() || guessing}>
                  Đoán
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="flex gap-2">
          <Link href="/" className="flex-1"><Button variant="outline" className="w-full">← Home</Button></Link>
          <Link href="/leaderboard" className="flex-1"><Button variant="outline" className="w-full">Leaderboard</Button></Link>
        </div>
      </div>
    </main>
  );
}
