'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { DrawingCanvas } from '@/components/canvas/DrawingCanvas';
import { useGameStore } from '@/lib/store';
import { api } from '@/lib/api';
import type { StrokeChunk } from '@drawbattle/shared';

export default function DailyChallengePage() {
  const router = useRouter();
  const player = useGameStore(s => s.player);
  const [phase, setPhase] = useState<'intro' | 'drawing' | 'done'>('intro');
  const [challenge, setChallenge] = useState<{ challengeId: string; word: string; timeLimit: number } | null>(null);
  const [strokes, setStrokes] = useState<StrokeChunk[]>([]);
  const [timeLeft, setTimeLeft] = useState(0);
  const [shareUrl, setShareUrl] = useState('');
  const startTimeRef = useRef(0);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!player) router.push('/');
  }, [player, router]);

  const finishDrawing = useCallback(async () => {
    if (!challenge) return;
    if (timerRef.current) clearInterval(timerRef.current);
    const durationMs = Date.now() - startTimeRef.current;
    try {
      await api.finalizeChallenge(
        challenge.challengeId,
        strokes.map(s => ({
          strokeId: s.strokeId,
          points: s.points,
          color: s.color,
          width: s.width,
        })),
        durationMs,
      );
    } catch {}
    setShareUrl(`${typeof window !== 'undefined' ? window.location.origin : ''}/challenge/${challenge.challengeId}`);
    setPhase('done');
  }, [challenge, strokes]);

  async function startDaily() {
    if (!player) return;
    try {
      let wordId: string | undefined;
      try {
        const res = await fetch('/api/daily/today', {
          headers: { Authorization: `Bearer ${player.token}` },
        });
        if (res.ok) {
          const daily = await res.json();
          wordId = daily?.word?.id;
        }
      } catch {}
      const c = await api.createChallenge(player.token, wordId ? { wordId } : {});
      setChallenge(c);
      setTimeLeft(c.timeLimit);
      startTimeRef.current = Date.now();
      setPhase('drawing');
      timerRef.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
        const remaining = Math.max(0, c.timeLimit - elapsed);
        setTimeLeft(remaining);
        if (remaining <= 0) {
          if (timerRef.current) clearInterval(timerRef.current);
        }
      }, 100);
    } catch {}
  }

  useEffect(() => {
    if (phase === 'drawing' && timeLeft === 0 && challenge) {
      finishDrawing();
    }
  }, [timeLeft, phase, challenge, finishDrawing]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  function handleStroke(chunk: StrokeChunk) {
    setStrokes(prev => [...prev, chunk]);
  }

  function handleClear() {
    setStrokes([]);
  }

  function handleUndo() {
    setStrokes(prev => prev.slice(0, -1));
  }

  function copyLink() {
    navigator.clipboard.writeText(shareUrl);
  }

  function shareLink() {
    if (navigator.share) {
      navigator.share({ title: 'DrawBattle - Thử thách hàng ngày', text: 'Bạn đoán được từ này không?', url: shareUrl });
    } else {
      copyLink();
    }
  }

  if (!player) return null;

  return (
    <main className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-orange-50 to-pink-50">
      <div className="w-full max-w-lg">
        {phase === 'intro' && (
          <Card className="w-full">
            <CardContent className="pt-8 pb-8 space-y-6 text-center">
              <div className="text-5xl">🎯</div>
              <h1 className="text-2xl font-bold">Thử thách hàng ngày</h1>
              <p className="text-muted-foreground">
                Mỗi ngày một từ khóa mới. Vẽ trong 15 giây và thách bạn bè đoán!
              </p>
              <div className="flex flex-col gap-3">
                <Button size="lg" onClick={startDaily}>Bắt đầu vẽ</Button>
                <Link href="/">
                  <Button variant="outline" className="w-full">Về trang chủ</Button>
                </Link>
              </div>
            </CardContent>
          </Card>
        )}

        {phase === 'drawing' && challenge && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Badge variant="outline">Từ: {challenge.word}</Badge>
              <Badge variant="secondary">{timeLeft}s</Badge>
            </div>
            <div className="aspect-[16/10]">
              <DrawingCanvas
                strokes={strokes}
                isDrawer={true}
                turnId="daily"
                onStroke={handleStroke}
                onClear={handleClear}
                onUndo={handleUndo}
              />
            </div>
            <Button className="w-full" onClick={finishDrawing}>Hoàn thành</Button>
          </div>
        )}

        {phase === 'done' && (
          <Card className="w-full">
            <CardContent className="pt-8 pb-8 space-y-6 text-center">
              <div className="text-5xl">🎉</div>
              <h2 className="text-xl font-bold">Tranh đã hoàn thành!</h2>
              <p className="text-muted-foreground">Chia sẻ để bạn bè đoán</p>
              <div className="p-3 bg-secondary/30 rounded-lg">
                <p className="text-xs font-mono break-all">{shareUrl}</p>
              </div>
              <div className="flex gap-2">
                <Button className="flex-1" onClick={shareLink}>Chia sẻ</Button>
                <Button variant="outline" className="flex-1" onClick={copyLink}>Copy link</Button>
              </div>
              <Link href="/">
                <Button variant="ghost" className="w-full">Về trang chủ</Button>
              </Link>
            </CardContent>
          </Card>
        )}
      </div>
    </main>
  );
}
