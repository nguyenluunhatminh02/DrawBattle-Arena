'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
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
      );
      setShareUrl(`${window.location.origin}/challenge/${challengeId}`);
    } catch {
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
      <main className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-purple-50 to-blue-50">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 space-y-4 text-center">
            <h2 className="text-2xl font-bold text-primary">Challenge tạo xong!</h2>
            <p className="text-muted-foreground">Gửi link cho bạn bè đoán</p>
            <div className="p-3 bg-secondary rounded break-all text-sm">{shareUrl}</div>
            <div className="flex gap-2">
              <Button className="flex-1" onClick={copyShareLink}>Copy Link</Button>
              <Button variant="outline" className="flex-1" onClick={() => router.push('/')}>
                Về trang chủ
              </Button>
            </div>
          </CardContent>
        </Card>
      </main>
    );
  }

  if (!started) {
    return (
      <main className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-purple-50 to-blue-50">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 space-y-4 text-center">
            <h2 className="text-2xl font-bold text-primary">Thách bạn bè</h2>
            <p className="text-muted-foreground">
              Bạn sẽ nhận một từ ngẫu nhiên và có 15 giây để vẽ. Sau đó gửi link cho bạn bè đoán!
            </p>
            <Button className="w-full" size="lg" onClick={handleStart} disabled={loading}>
              {loading ? 'Đang tạo...' : 'Bắt đầu vẽ'}
            </Button>
            <Button variant="ghost" onClick={() => router.push('/')}>Quay lại</Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-background">
      <header className="flex items-center justify-between px-4 py-2 border-b bg-card">
        <div className="flex items-center gap-3">
          <h1 className="font-bold text-primary">DrawBattle</h1>
          <Badge variant="destructive">{timeLeft}s</Badge>
        </div>
        <div className="text-center">
          <p className="text-xs text-muted-foreground">Vẽ từ:</p>
          <p className="font-bold text-lg">{word}</p>
        </div>
      </header>

      <div ref={containerRef} className="flex-1 min-h-0 bg-white m-2 rounded-lg overflow-hidden border">
        <canvas
          ref={canvasRef}
          className="w-full h-full touch-none"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        />
      </div>

      <div className="flex items-center gap-2 p-2 bg-card border-t">
        <div className="flex gap-1 flex-wrap">
          {COLORS.map(c => (
            <button
              key={c}
              onClick={() => setColor(c)}
              className={`w-7 h-7 rounded-full border-2 transition-transform ${color === c ? 'border-primary scale-110' : 'border-transparent'}`}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
        <div className="flex gap-1 ml-2">
          {BRUSH_SIZES.map(s => (
            <button
              key={s}
              onClick={() => setBrushSize(s)}
              className={`w-8 h-8 rounded flex items-center justify-center ${brushSize === s ? 'bg-primary/20' : 'bg-secondary'}`}
            >
              <div className="rounded-full bg-current" style={{ width: s, height: s }} />
            </button>
          ))}
        </div>
        <Button variant="outline" size="sm" onClick={handleUndo} className="ml-auto" disabled={strokes.length === 0}>
          Undo
        </Button>
      </div>
    </div>
  );
}
