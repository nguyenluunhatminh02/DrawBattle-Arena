'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { AppShell } from '@/components/layout/AppShell';
import { PageHeader } from '@/components/layout/PageHeader';
import { api } from '@/lib/api';
import { useGameStore } from '@/lib/store';

interface ReplayStroke {
  strokeId: string;
  points: Array<{ x: number; y: number }>;
  color: string;
  width: number;
}

interface DailyInfo {
  id: string;
  date: string;
  word: { id: string; difficulty: string; category?: { name: string } };
  hasReplay: boolean;
  replay: { strokes: ReplayStroke[]; durationMs: number } | null;
  answerCanonical?: string;
  userAttempt: { id: string; correct: boolean; answer: string } | null;
  stats: { totalAttempts: number; correctAttempts: number; successRate: number };
}

const DIFFICULTY_LABELS: Record<string, string> = {
  EASY: 'Dễ',
  MEDIUM: 'Trung bình',
  HARD: 'Khó',
};

export default function DailyChallengePage() {
  const router = useRouter();
  const player = useGameStore(s => s.player);
  const authToken = useGameStore(s => s.token);
  const [daily, setDaily] = useState<DailyInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [answer, setAnswer] = useState('');
  const [result, setResult] = useState<{ correct: boolean; answerCanonical?: string } | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [guessError, setGuessError] = useState<string | null>(null);
  const [guessing, setGuessing] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Reuse the community challenge replay renderer: normalized (0..1) points
  // are drawn onto a canvas sized to its container, so the source drawing is
  // identical across devices. Only strokes/durationMs arrive from the API.
  const drawFrame = useCallback((strokes: ReplayStroke[]) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (const stroke of strokes) {
      if (!Array.isArray(stroke.points) || stroke.points.length < 2) continue;
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
  }, []);

  const replay = daily?.replay ?? null;

  useEffect(() => {
    if (!replay) return;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const resize = () => {
      const rect = container.getBoundingClientRect();
      canvas.width = rect.width;
      canvas.height = rect.height;
      drawFrame(replay.strokes);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => observer.disconnect();
  }, [replay, drawFrame]);

  useEffect(() => {
    if (!replay || !replay.durationMs) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const strokes = replay.strokes;
    const totalPoints = strokes.reduce((sum, s) => sum + s.points.length, 0);
    if (totalPoints === 0) return;
    let animId: number;
    const startTime = Date.now();
    const animate = () => {
      const progress = Math.min((Date.now() - startTime) / replay.durationMs, 1);
      const targetPoints = Math.floor(progress * totalPoints);
      const partial: ReplayStroke[] = [];
      let count = 0;
      for (const stroke of strokes) {
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
      if (progress < 1) animId = requestAnimationFrame(animate);
      else drawFrame(strokes);
    };
    animId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animId);
  }, [replay, drawFrame]);

  // DAILY-03: when logged in, all requests carry the account JWT. The guest
  // token is only a fallback for anonymous players.
  const activeToken = authToken ?? player?.token;

  useEffect(() => {
    if (!activeToken) {
      router.push('/');
      return;
    }
    let cancelled = false;
    setLoading(true);
    api.getDailyToday(activeToken)
      .then(data => {
        if (cancelled) return;
        setDaily(data);
        if (data.userAttempt?.correct && data.answerCanonical) {
          setResult({ correct: true, answerCanonical: data.answerCanonical });
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setGuessError(err.message || 'Không tải được thử thách hàng ngày.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [activeToken, router]);

  async function handleGuess() {
    if (!answer.trim() || !daily || guessing) return;
    setGuessing(true);
    setGuessError(null);
    try {
      const res = await api.submitDailyAnswer(daily.id, answer.trim(), activeToken);
      setResult({ correct: res.correct, answerCanonical: res.answerCanonical });
      setRemaining(res.remainingAttempts);
      if (res.correct) setAnswer('');
    } catch (err) {
      // DAILY-04: surface attempt-limit and cooldown messages from the API.
      setGuessError(err instanceof Error && err.message ? err.message : 'Không gửi được đáp án. Vui lòng thử lại.');
    } finally {
      setGuessing(false);
    }
  }

  const guessCount = useMemo(() => daily?.stats.totalAttempts ?? 0, [daily]);
  const alreadySolved = Boolean(daily?.userAttempt?.correct || result?.correct);
  const shownAnswer = result?.answerCanonical ?? daily?.answerCanonical;

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

  if (guessError && !daily) {
    return (
      <AppShell variant="arena">
        <PageHeader title="Thử thách hàng ngày" actions={backAction} />
        <main className="mx-auto flex min-h-[70dvh] max-w-md items-center justify-center px-4 py-8">
          <Card className="border-panel-border/30 bg-panel/90 text-on-arena shadow-panel">
            <CardContent className="space-y-4 p-6 text-center">
              <h2 className="text-xl font-bold text-on-arena">Thử thách hàng ngày không khả dụng</h2>
              <p className="text-sm text-muted-on-arena">{guessError}</p>
              <div className="flex justify-center">{backAction}</div>
            </CardContent>
          </Card>
        </main>
      </AppShell>
    );
  }

  if (!daily) {
    return (
      <AppShell variant="arena">
        <PageHeader title="Thử thách hàng ngày" actions={backAction} />
        <main className="mx-auto flex min-h-[70dvh] max-w-md items-center justify-center px-4 py-8">
          <Card className="border-panel-border/30 bg-panel/90 text-on-arena shadow-panel">
            <CardContent className="space-y-4 p-6 text-center">
              <h2 className="text-xl font-bold text-on-arena">Thử thách hàng ngày không khả dụng</h2>
              <p className="text-sm text-muted-on-arena">Hãy thử lại sau hoặc quay về trang chủ.</p>
              <div className="flex justify-center">{backAction}</div>
            </CardContent>
          </Card>
        </main>
      </AppShell>
    );
  }

  return (
    <AppShell variant="arena">
      <PageHeader
        title="Thử thách hàng ngày"
        subtitle="Đoán từ của ngày hôm nay"
        actions={backAction}
      />
      <main className="safe-bottom mx-auto max-w-2xl space-y-4 px-4 py-6 md:py-8">
        <Card className="panel-arena border-panel-border/30 text-on-arena shadow-panel">
          <CardContent className="space-y-5 p-5 text-center">
            {/* DAILY-07: the real replay drawing is the source image for today. */}
            <div
              ref={containerRef}
              className="relative mx-auto aspect-[4/3] w-full max-w-lg overflow-hidden rounded-xl border border-panel-border/30 bg-white"
              data-testid="daily-replay-canvas-container"
            >
              {replay ? (
                <canvas
                  ref={canvasRef}
                  role="img"
                  aria-label="Bức tranh thử thách hàng ngày"
                  data-testid="daily-replay-canvas"
                  className="h-full w-full"
                />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-arena-800" data-testid="daily-no-replay">
                  <span className="text-4xl" aria-hidden="true">🖼️</span>
                  <p className="text-sm font-medium">Chưa có tranh cho thử thách hôm nay</p>
                  <p className="text-xs text-muted-on-arena">Hãy thử lại sau khi cộng đồng đã vẽ nét đầu tiên.</p>
                </div>
              )}
            </div>
            <div className="space-y-1">
              <h2 className="text-2xl font-bold text-on-arena">Thử thách hàng ngày</h2>
              <p className="text-sm text-muted-on-arena">
                Chủ đề: <strong className="text-on-arena">{daily.word?.category?.name || 'Hỗn hợp'}</strong>
                {' · '}
                Độ khó: <strong className="text-on-arena">{DIFFICULTY_LABELS[daily.word?.difficulty] ?? daily.word?.difficulty ?? 'Đang cập nhật'}</strong>
              </p>
              {/* DAILY-01: explain what to do and the rules of the daily game. */}
              <p className="text-sm text-muted-on-arena">
                Mỗi ngày một từ mới. Nhập đáp án bạn nghĩ bức tranh đại diện; từ đồng nghĩa cũng được chấp nhận.
                Bạn có tối đa 10 lượt đoán và cần đợi một giây giữa hai lần đoán.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-arena-800/40 p-3">
                <p className="score-number text-2xl font-bold text-on-arena">{guessCount}</p>
                <p className="text-xs text-muted-on-arena">Lượt đoán</p>
              </div>
              <div className="rounded-lg bg-arena-800/40 p-3">
                <p className="score-number text-2xl font-bold text-success">{(daily.stats?.successRate ?? 0).toFixed(0)}%</p>
                <p className="text-xs text-muted-on-arena">Tỷ lệ đúng</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {alreadySolved ? (
          <Card className="panel-arena border-panel-border/30 text-on-arena shadow-panel">
            <CardContent className="space-y-4 p-5 text-center">
              <span className="inline-flex rounded-md bg-success/20 px-4 py-1.5 text-base font-semibold text-success">
                Bạn đã đoán đúng!
              </span>
              {shownAnswer && (
                <p className="score-number text-2xl font-bold text-on-arena">{shownAnswer}</p>
              )}
              <p className="text-sm text-muted-on-arena">Quay lại vào ngày mai để thử từ mới.</p>
              <div className="flex justify-center">{backAction}</div>
            </CardContent>
          </Card>
        ) : (
          <Card className="panel-arena border-panel-border/30 text-on-arena shadow-panel">
            <CardContent className="space-y-3 p-5">
              <p className="text-center font-medium text-on-arena">Bạn đoán đây là gì?</p>
              {remaining !== null && (
                <p className="text-center text-xs text-muted-on-arena">Còn {remaining} lượt đoán hôm nay.</p>
              )}
              {result && !result.correct && (
                <p role="status" className="text-center text-sm text-warning">Sai rồi! Thử lại nào.</p>
              )}
              {guessError && (
                <p role="alert" className="text-center text-sm text-destructive">{guessError}</p>
              )}
              <form
                className="flex gap-2"
                onSubmit={e => {
                  e.preventDefault();
                  void handleGuess();
                }}
              >
                <Input
                  value={answer}
                  onChange={e => setAnswer(e.target.value)}
                  placeholder="Nhập đáp án..."
                  disabled={guessing}
                  autoComplete="off"
                />
                <Button type="submit" className="min-w-[72px]" disabled={!answer.trim() || guessing} aria-busy={guessing}>
                  {guessing ? 'Đang gửi...' : 'Đoán'}
                </Button>
              </form>
            </CardContent>
          </Card>
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
