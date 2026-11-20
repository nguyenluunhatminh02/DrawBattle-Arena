'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { AppShell } from '@/components/layout/AppShell';
import { PageHeader } from '@/components/layout/PageHeader';
import { COLORS, BRUSH_SIZES } from '@drawbattle/shared';
import { useGameStore } from '@/lib/store';
import { api } from '@/lib/api';

interface Stroke {
  strokeId: string;
  points: Array<{ x: number; y: number }>;
  color: string;
  width: number;
}

export default function ChallengeCreatePage() {
  const router = useRouter();
  const player = useGameStore(s => s.player);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [word, setWord] = useState<string | null>(null);
  const [timeLimit, setTimeLimit] = useState(15);
  const [timeLeft, setTimeLeft] = useState(0);
  const [started, setStarted] = useState(false);
  const [finished, setFinished] = useState(false);
  const [color, setColor] = useState<string>(COLORS[0]);
  const [brushSize, setBrushSize] = useState<number>(BRUSH_SIZES[1]);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const currentStrokeRef = useRef<Stroke | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const finishedRef = useRef(false);
  const finishRef = useRef<() => void>(() => {});
  strokesRef.current = strokes;
  const drawingRef = useRef(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState(false);

  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  useEffect(() => {
    if (!hydrated) return;
    if (!player) router.push('/');
  }, [hydrated, player, router]);

  async function handleStart() {
    if (!player) return;
    setLoading(true);
    try {
      const res = await api.createChallenge(player.token);
      setChallengeId(res.challengeId);
      setWord(res.word);
      setTimeLimit(res.timeLimit);
      setTimeLeft(res.timeLimit);
      setStarted(true);
      setLoading(false);
    } catch {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!started || finished) return;
    const interval = setInterval(() => {
      setTimeLeft(t => {
        if (t <= 1) {
          clearInterval(interval);
          finishRef.current();
          return 0;
        }
        return t - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [started, finished]);

  async function handleFinish() {
    if (!challengeId || finishedRef.current) return;
    finishedRef.current = true;
    setFinished(true);
    setFinalizing(true);
    const allStrokes = [...strokesRef.current];
    if (currentStrokeRef.current) allStrokes.push(currentStrokeRef.current);
    try {
      await api.finalizeChallenge(
        challengeId,
        allStrokes.map(s => ({
          strokeId: s.strokeId,
          points: s.points,
          color: s.color,
          width: s.width,
        })),
        timeLimit * 1000,
        player?.token,
      );
      setShareUrl(`${window.location.origin}/challenge/${challengeId}`);
    } catch {
      setFinalizeError(true);
    } finally {
      setFinalizing(false);
    }
  }
  finishRef.current = handleFinish;

  function redraw(allStrokes: Stroke[]) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (const stroke of allStrokes) {
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
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const resize = () => {
      const rect = container.getBoundingClientRect();
      canvas.width = rect.width;
      canvas.height = rect.height;
      redraw(strokes);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => observer.disconnect();
  }, [strokes]);

  useEffect(() => {
    redraw(strokes);
  }, [strokes]);

  function getPoint(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (finished) return;
    e.preventDefault();
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch {}
    const p = getPoint(e);
    if (!p) return;
    drawingRef.current = true;
    currentStrokeRef.current = { strokeId: crypto.randomUUID(), points: [p], color, width: brushSize };
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current || !currentStrokeRef.current) return;
    e.preventDefault();
    const p = getPoint(e);
    if (!p) return;
    currentStrokeRef.current.points.push(p);
    redraw([...strokes, currentStrokeRef.current]);
  }

  function handlePointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current || !currentStrokeRef.current) return;
    e.preventDefault();
    drawingRef.current = false;
    const s = currentStrokeRef.current;
    setStrokes(prev => [...prev, s]);
    currentStrokeRef.current = null;
  }

  function handleUndo() {
    setStrokes(prev => prev.slice(0, -1));
  }

  function copyShareLink() {
    if (shareUrl) navigator.clipboard.writeText(shareUrl);
  }

  if (!hydrated || !player) return null;

  if (shareUrl) {
    return (
      <AppShell>
        <PageHeader title="Đấu Trường Nét" subtitle="Thách thức hoàn tất" />
        <main className="mx-auto flex w-full max-w-lg flex-col gap-4 px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-6">
          <Card className="border-panel-border/30 bg-panel/90 text-on-arena shadow-panel">
            <CardContent className="space-y-4 p-5 text-center sm:p-6">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-success/15 ring-1 ring-success/40" aria-hidden="true">
                <span className="text-2xl text-success">✓</span>
              </div>
              <div className="space-y-1">
                <h2 className="text-xl font-bold sm:text-2xl">Tạo thách thức thành công!</h2>
                <p className="text-sm text-muted-on-arena">Gửi liên kết cho bạn bè để đoán bức tranh của bạn.</p>
              </div>
              <div className="rounded-lg bg-arena-950/60 p-3 ring-1 ring-panel-border/30">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-on-arena">Liên kết chia sẻ</p>
                <p className="mt-1 break-all text-sm text-on-arena">{shareUrl}</p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <Button className="min-h-11 w-full" onClick={copyShareLink}>Sao chép liên kết</Button>
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
        </main>
      </AppShell>
    );
  }

  if (!started) {
    return (
      <AppShell>
        <PageHeader title="Đấu Trường Nét" subtitle="Tạo thách thức" />
        <main className="mx-auto flex w-full max-w-lg flex-col gap-4 px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-6">
          <Card className="border-panel-border/30 bg-panel/90 text-on-arena shadow-panel">
            <CardContent className="space-y-5 p-5 text-center sm:p-6">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-paper shadow-paper" aria-hidden="true">
                <span className="text-3xl text-paper-ink">✎</span>
              </div>
              <div className="space-y-2">
                <h2 className="text-xl font-bold sm:text-2xl">Thách bạn bè</h2>
                <p className="text-sm text-muted-on-arena">
                  Bạn sẽ nhận một từ ngẫu nhiên và có 15 giây để vẽ. Sau đó gửi liên kết cho bạn bè đoán!
                </p>
              </div>
              <Button className="min-h-11 w-full" size="lg" onClick={handleStart} disabled={loading} aria-busy={loading}>
                {loading ? 'Đang tạo thách thức...' : 'Bắt đầu vẽ'}
              </Button>
              {loading && (
                <p role="status" className="text-sm text-muted-on-arena">Đang chuẩn bị từ ngẫu nhiên...</p>
              )}
              <Link
                href="/"
                className="inline-flex min-h-11 w-full items-center justify-center rounded-md text-sm font-medium text-muted-on-arena transition-colors hover:bg-panel/70 hover:text-on-arena focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-panel-border"
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

  return (
    <AppShell>
      <main className="mx-auto flex min-h-[100dvh] w-full max-w-2xl flex-col gap-3 px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-[calc(0.75rem+env(safe-area-inset-top))] sm:px-4 sm:gap-4">
        <header className="panel-arena flex items-center justify-between gap-2 rounded-xl px-3 py-2 shadow-panel sm:px-4">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <Link
              href="/"
              aria-label="← Về trang chủ"
              className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-medium text-on-arena transition-colors hover:bg-panel/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-panel-border sm:px-3 sm:text-sm"
            >
              <span aria-hidden="true">←</span>
              <span className="hidden sm:inline">Về trang chủ</span>
              <span className="sr-only sm:hidden">Về trang chủ</span>
            </Link>
            <div className="min-w-0">
              <p className="truncate text-sm font-bold text-on-arena sm:text-base">Đấu Trường Nét</p>
              <p className="text-[11px] text-muted-on-arena">Đang vẽ thách thức</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className="text-right">
              <p className="text-[11px] text-muted-on-arena">Vẽ từ</p>
              <p className="max-w-[28vw] truncate text-base font-bold text-on-arena sm:max-w-none" aria-live="polite">
                {word}
              </p>
            </div>
            <span
              className={`min-w-[3.25rem] rounded-lg px-2 py-1.5 text-center text-base font-bold tabular-nums ${
                timeLeft <= 5 ? 'bg-destructive text-destructive-foreground' : 'bg-panel-border/30 text-on-arena'
              }`}
              role="timer"
              aria-label={`Thời gian còn lại: ${timeLeft} giây`}
            >
              {timeLeft}s
            </span>
          </div>
        </header>

        {finished && (
          <div
            role="status"
            className="panel-arena flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-on-arena"
          >
            <span aria-hidden="true">{finalizeError ? '!' : '✓'}</span>
            <span>
              {finalizeError
                ? 'Không thể lưu thách thức. Vui lòng thử lại.'
                : finalizing
                  ? 'Đang lưu bức tranh...'
                  : 'Đã hết giờ. Bức tranh đã được lưu!'}
            </span>
          </div>
        )}

        <div className="paper-mat relative min-h-0 flex-1 rounded-xl p-2 shadow-paper sm:p-3">
          <div ref={containerRef} className="h-full min-h-[16rem] w-full overflow-hidden rounded-lg bg-paper ring-1 ring-paper-ink/15 sm:min-h-[20rem]">
            <canvas
              ref={canvasRef}
              className="h-full w-full touch-none"
              aria-label="Khu vực vẽ thách thức"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
            />
          </div>
          {finished && (
            <div className="pointer-events-none absolute inset-2 flex items-start justify-center rounded-lg bg-paper/70 pt-6 sm:inset-3">
              <span className="rounded-full bg-arena-950/80 px-4 py-2 text-sm font-semibold text-on-arena">
                {finalizeError ? 'Chưa lưu được thách thức' : 'Đã hoàn thành'}
              </span>
            </div>
          )}
        </div>

        <div className="panel-arena space-y-2 rounded-xl p-3 shadow-panel sm:p-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <fieldset className="flex min-w-0 items-center gap-1.5">
              <legend className="sr-only">Màu cọ</legend>
              {COLORS.map(c => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  disabled={finished}
                  className={`h-11 w-11 shrink-0 rounded-full border-2 transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-panel-border focus-visible:ring-offset-2 focus-visible:ring-offset-panel disabled:opacity-50 ${
                    color === c ? 'scale-110 border-on-arena ring-2 ring-panel-border' : 'border-transparent'
                  }`}
                  style={{ backgroundColor: c }}
                  aria-label={`Màu ${c}`}
                  aria-pressed={color === c}
                />
              ))}
            </fieldset>
            <fieldset className="flex items-center gap-1.5">
              <legend className="sr-only">Kích thước cọ</legend>
              {BRUSH_SIZES.map(s => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setBrushSize(s)}
                  disabled={finished}
                  className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-panel-border disabled:opacity-50 ${
                    brushSize === s ? 'bg-panel-border/30 ring-1 ring-panel-border' : 'bg-arena-950/50'
                  }`}
                  aria-label={`Cỡ cọ ${s}`}
                  aria-pressed={brushSize === s}
                >
                  <span className="rounded-full bg-on-arena" style={{ width: s + 4, height: s + 4 }} aria-hidden="true" />
                </button>
              ))}
            </fieldset>
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-panel-border/20 pt-3">
            <p className="text-xs text-muted-on-arena">Chạm và kéo để vẽ trên giấy.</p>
            <Button variant="outline" onClick={handleUndo} className="min-h-11 shrink-0" disabled={strokes.length === 0 || finished}>
              Hoàn tác
            </Button>
          </div>
        </div>
      </main>
    </AppShell>
  );
}
