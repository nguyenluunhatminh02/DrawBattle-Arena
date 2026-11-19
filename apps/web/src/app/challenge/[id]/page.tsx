'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { useGameStore } from '@/lib/store';
import type { StrokeChunk } from '@drawbattle/shared';

interface ReplayStroke {
  strokeId: string;
  points: Array<{ x: number; y: number }>;
  color: string;
  width: number;
}

export default function ChallengePlayPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const player = useGameStore(s => s.player);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [replay, setReplay] = useState<ReplayStroke[] | null>(null);
  const [durationMs, setDurationMs] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [expired, setExpired] = useState(false);
  const [noReplay, setNoReplay] = useState(false);

  const [answer, setAnswer] = useState('');
  const [attemptNo, setAttemptNo] = useState(0);
  const [remaining, setRemaining] = useState(3);
  const [result, setResult] = useState<{ correct: boolean; answer?: string } | null>(null);
  const [guessing, setGuessing] = useState(false);

  useEffect(() => {
    api.getChallengeInfo(id, player?.token).then(info => {
      if (info.status === 'EXPIRED') {
        setExpired(true);
        return;
      }
      if (!info.hasReplay || !info.replay) {
        setNoReplay(true);
        return;
      }
      setReplay(info.replay.strokes as ReplayStroke[]);
      setDurationMs(info.replay.durationMs);
      setRemaining(info.maxAttempts - info.attemptCount);
      setLoaded(true);
    }).catch(() => {
      setExpired(true);
    });
  }, [id]);

  const drawFrame = useCallback(
    (strokesToRender: ReplayStroke[]) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (const stroke of strokesToRender) {
        if (stroke.points.length < 2) continue;
        ctx.beginPath();
        ctx.strokeStyle = stroke.color;
        ctx.lineWidth = stroke.width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.moveTo(stroke.points[0].x * canvas.width, stroke.points[0].y * canvas.height);
        for (let i = 1; i < stroke.points.length; i++) {
          ctx.lineTo(stroke.points[i].x * canvas.width, stroke.points[i].y * canvas.height);
        }
        ctx.stroke();
      }
    },
    [],
  );

  useEffect(() => {
    if (!loaded || !replay) return;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const resize = () => {
      const rect = container.getBoundingClientRect();
      canvas.width = rect.width;
      canvas.height = rect.height;
      drawFrame(replay);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => observer.disconnect();
  }, [loaded, replay, drawFrame]);

  useEffect(() => {
    if (!loaded || !replay || !durationMs) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const strokesToAnimate = replay;

    let animId: number;
    const startTime = Date.now();
    const totalPoints = strokesToAnimate.reduce((sum, s) => sum + s.points.length, 0);

    function animate() {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / durationMs, 1);
      const targetPoints = Math.floor(progress * totalPoints);

      const partial: ReplayStroke[] = [];
      let count = 0;
      for (const stroke of strokesToAnimate) {
        if (count >= targetPoints) break;
        const remaining = targetPoints - count;
        if (stroke.points.length <= remaining) {
          partial.push(stroke);
          count += stroke.points.length;
        } else {
          partial.push({ ...stroke, points: stroke.points.slice(0, remaining) });
          count += remaining;
        }
      }

      drawFrame(partial);
      if (progress < 1) {
        animId = requestAnimationFrame(animate);
      } else {
        drawFrame(strokesToAnimate);
      }
    }

    animId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animId);
  }, [loaded, replay, durationMs, drawFrame]);

  async function handleGuess() {
    if (!answer.trim() || remaining <= 0) return;
    setGuessing(true);
    try {
      const res = await api.submitChallengeGuess(id, answer.trim(), player?.token);
      setAttemptNo(res.attemptNo);
      setRemaining(res.remainingAttempts);
      setResult({ correct: res.correct, answer: res.answer });
      setAnswer('');
    } catch {
    }
    setGuessing(false);
  }

  if (expired) {
    return (
      <main className="min-h-screen flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center space-y-4">
            <h2 className="text-2xl font-bold">Challenge đã hết hạn</h2>
            <Button onClick={() => router.push('/')}>Về trang chủ</Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  if (noReplay) {
    return (
      <main className="min-h-screen flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center space-y-4">
            <h2 className="text-2xl font-bold">Tranh chưa được vẽ</h2>
            <p className="text-muted-foreground">Người tạo chưa hoàn thành bức tranh.</p>
            <Button onClick={() => router.push('/')}>Về trang chủ</Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-4 bg-gradient-to-br from-purple-50 to-blue-50 gap-4">
      <div className="w-full max-w-lg">
        <div className="flex items-center justify-between mb-2">
          <h1 className="font-bold text-primary text-xl">DrawBattle</h1>
          <Badge>Lượt đoán còn: {remaining}</Badge>
        </div>
        <div ref={containerRef} className="w-full aspect-[16/10] bg-white rounded-lg overflow-hidden border">
          <canvas ref={canvasRef} className="w-full h-full" />
        </div>
      </div>

      {result && (result.correct || remaining === 0) ? (
        <Card className="w-full max-w-lg">
          <CardContent className="pt-6 space-y-4 text-center">
            {result.correct ? (
              <>
                <Badge className="bg-green-500 text-white text-lg px-4 py-1">Chính xác!</Badge>
                <p className="text-2xl font-bold text-primary">{result.answer}</p>
              </>
            ) : (
              <>
                <Badge variant="destructive" className="text-lg px-4 py-1">Sai rồi!</Badge>
                {result.answer && (
                  <p className="text-lg">Đáp án: <strong className="text-primary">{result.answer}</strong></p>
                )}
                {remaining > 0 && <p className="text-muted-foreground">Thử lại nào!</p>}
              </>
            )}
            <div className="flex gap-2">
              <Button className="flex-1" onClick={() => router.push('/challenge/create')}>
                Tạo challenge mới
              </Button>
              <Button variant="outline" className="flex-1" onClick={() => router.push('/')}>
                Trang chủ
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="w-full max-w-lg">
          <CardContent className="pt-6 space-y-3">
            <p className="text-center font-medium">Bạn đoán đây là gì?</p>
            {result && !result.correct && (
              <p className="text-center text-sm text-destructive">Sai rồi! Còn {remaining} lượt.</p>
            )}
            <div className="flex gap-2">
              <Input
                value={answer}
                onChange={e => setAnswer(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleGuess()}
                placeholder="Nhập đáp án..."
                disabled={remaining <= 0 || guessing}
              />
              <Button onClick={handleGuess} disabled={!answer.trim() || remaining <= 0 || guessing}>
                Đoán
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </main>
  );
}
