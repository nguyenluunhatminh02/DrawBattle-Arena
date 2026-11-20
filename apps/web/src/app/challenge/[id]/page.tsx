'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { AppShell } from '@/components/layout/AppShell';
import { PageHeader } from '@/components/layout/PageHeader';
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
  const [loading, setLoading] = useState(true);
  const [expired, setExpired] = useState(false);
  const [noReplay, setNoReplay] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [answer, setAnswer] = useState('');
  const [attemptNo, setAttemptNo] = useState(0);
  const [remaining, setRemaining] = useState(3);
  const [result, setResult] = useState<{ correct: boolean; answer?: string } | null>(null);
  const [guessing, setGuessing] = useState(false);

  useEffect(() => {
    api.getChallengeInfo(id, player?.token).then(info => {
      setLoading(false);
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
      setLoading(false);
      setLoadError('Không tải được thách thức. Vui lòng kiểm tra liên kết và thử lại.');
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

  function StateCard({
    title,
    description,
    tone = 'neutral',
  }: {
    title: string;
    description?: string;
    tone?: 'neutral' | 'warning' | 'success';
  }) {
    const toneClass =
      tone === 'success'
        ? 'bg-success/15 text-success ring-success/40'
        : tone === 'warning'
          ? 'bg-warning/15 text-warning ring-warning/40'
          : 'bg-panel-border/20 text-muted-on-arena ring-panel-border/30';

    return (
      <AppShell>
        <PageHeader title="Đấu Trường Nét" subtitle="Thách thức tranh" />
        <main className="mx-auto flex w-full max-w-lg flex-col gap-4 px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-6">
          <Card className="border-panel-border/30 bg-panel/90 text-on-arena shadow-panel">
            <CardContent className="space-y-4 p-5 text-center sm:p-6">
              <div className={`mx-auto flex h-14 w-14 items-center justify-center rounded-2xl ring-1 ${toneClass}`} aria-hidden="true">
                <span className="text-2xl">{tone === 'success' ? '✓' : tone === 'warning' ? '!' : '✎'}</span>
              </div>
              <div className="space-y-1">
                <h2 className="text-xl font-bold sm:text-2xl">{title}</h2>
                {description && <p className="text-sm text-muted-on-arena">{description}</p>}
              </div>
              <Link
                href="/"
                className="inline-flex min-h-11 w-full items-center justify-center rounded-md border border-panel-border/40 px-4 text-sm font-medium text-on-arena transition-colors hover:bg-panel/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-panel-border"
                aria-label="← Về trang chủ"
              >
                ← Về trang chủ
              </Link>
            </CardContent>
          </Card>
        </main>
      </AppShell>
    );
  }

  if (loading) {
    return (
      <AppShell>
        <PageHeader title="Đấu Trường Nét" subtitle="Đang tải thách thức" />
        <main className="mx-auto flex w-full max-w-lg flex-col gap-4 px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-6">
          <Card className="border-panel-border/30 bg-panel/90 text-on-arena shadow-panel" role="status" aria-live="polite">
            <CardContent className="space-y-4 p-5 text-center sm:p-6">
              <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-panel-border/30 border-t-on-arena" aria-hidden="true" />
              <h2 className="text-lg font-semibold">Đang tải thách thức...</h2>
              <p className="text-sm text-muted-on-arena">Đang chuẩn bị bức tranh cho bạn.</p>
            </CardContent>
          </Card>
        </main>
      </AppShell>
    );
  }

  if (loadError) {
    return <StateCard title="Không tìm thấy thách thức" description={loadError} tone="warning" />;
  }

  if (expired) {
    return (
      <StateCard
        title="Thách thức đã hết hạn"
        description="Liên kết này không còn hiệu lực. Hãy tạo thách thức mới để tiếp tục chơi."
        tone="warning"
      />
    );
  }

  if (noReplay) {
    return (
      <StateCard
        title="Chưa có bức tranh để đoán"
        description="Người tạo chưa hoàn thành bức tranh hoặc thách thức chưa được lưu."
      />
    );
  }

  const solved = Boolean(result?.correct);
  const outOfAttempts = !solved && remaining <= 0 && attemptNo > 0;
  const finished = solved || outOfAttempts;

  return (
    <AppShell>
      <div className="mx-auto flex min-h-[100dvh] w-full max-w-xl flex-col gap-3 px-3 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-[calc(0.75rem+env(safe-area-inset-top))] sm:px-4 sm:gap-4">
        <PageHeader
          title="Đấu Trường Nét"
          subtitle="Đoán bức tranh"
          backHref="/"
          actions={
            <span className="rounded-full border border-panel-border/40 bg-panel/70 px-3 py-1.5 text-xs font-semibold text-on-arena sm:text-sm">
              {remaining > 0 ? `Còn ${remaining} lượt đoán` : 'Hết lượt đoán'}
            </span>
          }
        />

        <div className="paper-mat rounded-xl p-2 shadow-paper sm:p-3">
          <div ref={containerRef} className="aspect-[16/10] w-full overflow-hidden rounded-lg bg-paper ring-1 ring-paper-ink/15">
            <canvas
              ref={canvasRef}
              className="h-full w-full"
              role="img"
              aria-label="Bức tranh thách thức đang được phát lại"
            />
          </div>
          <p className="pt-2 text-center text-xs text-paper-ink/70">
            Xem bức tranh và đoán từ khóa bên dưới.
          </p>
        </div>

        {finished ? (
          <Card className="border-panel-border/30 bg-panel/90 text-on-arena shadow-panel">
            <CardContent className="space-y-4 p-5 text-center sm:p-6">
              <div
                className={`mx-auto flex h-14 w-14 items-center justify-center rounded-2xl ring-1 ${
                  solved ? 'bg-success/15 text-success ring-success/40' : 'bg-destructive/15 text-destructive ring-destructive/40'
                }`}
                aria-hidden="true"
              >
                <span className="text-2xl">{solved ? '✓' : '!'}</span>
              </div>
              <div className="space-y-1" role="status" aria-live="polite">
                <h2 className="text-xl font-bold">{solved ? 'Chính xác!' : 'Hết lượt đoán'}</h2>
                {result?.answer ? (
                  <p className="text-lg">
                    Đáp án: <strong className="text-primary-foreground">{result.answer}</strong>
                  </p>
                ) : (
                  <p className="text-sm text-muted-on-arena">Bạn đã dùng hết lượt đoán cho thách thức này.</p>
                )}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <Button className="min-h-11 w-full" onClick={() => router.push('/challenge/create')}>
                  Tạo thách thức mới
                </Button>
                <Link
                  href="/"
                  className="inline-flex min-h-11 w-full items-center justify-center rounded-md border border-panel-border/40 px-4 text-sm font-medium text-on-arena transition-colors hover:bg-panel/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-panel-border"
                  aria-label="← Về trang chủ"
                >
                  ← Về trang chủ
                </Link>
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card className="border-panel-border/30 bg-panel/90 text-on-arena shadow-panel">
            <CardContent className="space-y-3 p-5 sm:p-6">
              <label htmlFor="challenge-answer" className="block text-center text-sm font-semibold">
                Bạn đoán đây là gì?
              </label>
              {result && !result.correct && (
                <p role="status" aria-live="polite" className="text-center text-sm text-warning">
                  Sai rồi! Còn {remaining} lượt. Thử lại nào!
                </p>
              )}
              <form
                className="flex flex-col gap-2 sm:flex-row"
                onSubmit={e => {
                  e.preventDefault();
                  void handleGuess();
                }}
              >
                <Input
                  id="challenge-answer"
                  value={answer}
                  onChange={e => setAnswer(e.target.value)}
                  placeholder="Nhập đáp án..."
                  disabled={guessing}
                  autoComplete="off"
                  className="min-h-11 flex-1 border-panel-border/40 bg-arena-950/60 text-on-arena placeholder:text-muted-on-arena"
                />
                <Button
                  type="submit"
                  className="min-h-11 w-full sm:w-auto"
                  disabled={!answer.trim() || guessing}
                  aria-busy={guessing}
                >
                  {guessing ? 'Đang gửi...' : 'Đoán'}
                </Button>
              </form>
            </CardContent>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
