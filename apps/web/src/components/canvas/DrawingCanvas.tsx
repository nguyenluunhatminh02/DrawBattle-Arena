'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { COLORS, BRUSH_SIZES, GAME_CONSTANTS } from '@drawbattle/shared';
import type { StrokeChunk } from '@drawbattle/shared';
import { Button } from '@/components/ui/button';

interface DrawingCanvasProps {
  strokes: StrokeChunk[];
  isDrawer: boolean;
  turnId: string;
  onStroke: (chunk: StrokeChunk) => void;
  onStrokeStart?: (data: { turnId: string; strokeId: string }) => void;
  onStrokeEnd?: (data: { turnId: string; strokeId: string }) => void;
  onClear: () => void;
  onUndo?: () => void;
}

interface LocalStroke {
  strokeId: string;
  points: Array<{ x: number; y: number }>;
  color: string;
  width: number;
  isEraser: boolean;
}

export function DrawingCanvas({ strokes, isDrawer, turnId, onStroke, onStrokeStart, onStrokeEnd, onClear, onUndo }: DrawingCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [color, setColor] = useState<string>(COLORS[0]);
  const [brushSize, setBrushSize] = useState<number>(BRUSH_SIZES[1]);
  const [tool, setTool] = useState<'pen' | 'eraser'>('pen');
  const drawingRef = useRef(false);
  const currentStrokeRef = useRef<LocalStroke | null>(null);
  const seqRef = useRef(0);
  const batchTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pendingPointsRef = useRef<Array<{ x: number; y: number }>>([]);
  const dprRef = useRef(1);

  const getCanvasPoint = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) / rect.width,
        y: (e.clientY - rect.top) / rect.height,
      };
    },
    [],
  );

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = dprRef.current;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, w, h);

    const allStrokes = [...strokes];
    if (currentStrokeRef.current) {
      allStrokes.push({
        turnId,
        strokeId: currentStrokeRef.current.strokeId,
        seq: 0,
        points: currentStrokeRef.current.points,
        color: currentStrokeRef.current.isEraser ? '#FFFFFF' : currentStrokeRef.current.color,
        width: currentStrokeRef.current.isEraser ? Math.min(20, currentStrokeRef.current.width * 3) : currentStrokeRef.current.width,
      });
    }

    for (const stroke of allStrokes) {
      if (stroke.points.length === 0) continue;
      if (stroke.points.length === 1) {
        ctx.beginPath();
        ctx.fillStyle = stroke.color;
        ctx.arc(stroke.points[0].x * w, stroke.points[0].y * h, stroke.width / 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.moveTo(stroke.points[0].x * w, stroke.points[0].y * h);
      for (let i = 1; i < stroke.points.length; i++) {
        ctx.lineTo(stroke.points[i].x * w, stroke.points[i].y * h);
      }
      ctx.stroke();
    }
    ctx.restore();
  }, [strokes, turnId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      dprRef.current = dpr;
      const rect = container.getBoundingClientRect();
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      redraw();
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => observer.disconnect();
  }, [redraw]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  const flushBatch = useCallback(() => {
    if (!currentStrokeRef.current || pendingPointsRef.current.length === 0) return;
    const stroke = currentStrokeRef.current;
    const chunk: StrokeChunk = {
      turnId,
      strokeId: stroke.strokeId,
      seq: seqRef.current++,
      points: [...pendingPointsRef.current],
      color: stroke.isEraser ? '#FFFFFF' : stroke.color,
      width: stroke.isEraser ? Math.min(20, stroke.width * 3) : stroke.width,
    };
    pendingPointsRef.current = [];
    onStroke(chunk);
  }, [turnId, onStroke]);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawer) return;
    e.preventDefault();
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch {}
    const point = getCanvasPoint(e);
    if (!point) return;
    drawingRef.current = true;
    const strokeId = crypto.randomUUID();
    const isEraser = tool === 'eraser';
    currentStrokeRef.current = { strokeId, points: [point], color, width: brushSize, isEraser };
    seqRef.current = 0;
    pendingPointsRef.current = [point];
    onStrokeStart?.({ turnId, strokeId });
    batchTimerRef.current = setInterval(flushBatch, GAME_CONSTANTS.STROKE_BATCH_MS);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawer || !drawingRef.current || !currentStrokeRef.current) return;
    e.preventDefault();
    const point = getCanvasPoint(e);
    if (!point) return;
    currentStrokeRef.current.points.push(point);
    pendingPointsRef.current.push(point);
    drawIncremental(point);
  };

  const drawIncremental = (point: { x: number; y: number }) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx || !currentStrokeRef.current) return;
    const dpr = dprRef.current;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    const stroke = currentStrokeRef.current;
    const pts = stroke.points;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = stroke.isEraser ? '#FFFFFF' : stroke.color;
    ctx.fillStyle = stroke.isEraser ? '#FFFFFF' : stroke.color;
    ctx.lineWidth = stroke.isEraser ? Math.min(20, stroke.width * 3) : stroke.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x * w, pts[0].y * h, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      const prev = pts[pts.length - 2];
      ctx.moveTo(prev.x * w, prev.y * h);
      ctx.lineTo(point.x * w, point.y * h);
      ctx.stroke();
    }
    ctx.restore();
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawer || !drawingRef.current || !currentStrokeRef.current) return;
    e.preventDefault();
    drawingRef.current = false;
    if (batchTimerRef.current) {
      clearInterval(batchTimerRef.current);
      batchTimerRef.current = null;
    }
    flushBatch();
    const stroke = currentStrokeRef.current;
    onStrokeEnd?.({ turnId, strokeId: stroke.strokeId });
    currentStrokeRef.current = null;
  };

  useEffect(() => {
    return () => {
      if (batchTimerRef.current) {
        clearInterval(batchTimerRef.current);
        batchTimerRef.current = null;
      }
    };
  }, []);

  return (
    <div className="flex flex-col h-full">
      <div ref={containerRef} className="flex-1 min-h-0 bg-white rounded-lg overflow-hidden border">
        <canvas
          ref={canvasRef}
          className="w-full h-full touch-none block"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        />
      </div>
      {isDrawer && (
        <div className="flex items-center gap-1 md:gap-2 mt-2 p-1.5 md:p-2 bg-card rounded-lg border overflow-x-auto">
          <div className="flex gap-0.5 md:gap-1 shrink-0">
            <button
              onClick={() => setTool('pen')}
              className={`w-7 h-7 md:w-8 md:h-8 rounded flex items-center justify-center text-xs ${tool === 'pen' ? 'bg-primary/20 font-bold' : 'bg-secondary'}`}
              title="Bút"
            >
              ✏️
            </button>
            <button
              onClick={() => setTool('eraser')}
              className={`w-7 h-7 md:w-8 md:h-8 rounded flex items-center justify-center text-xs ${tool === 'eraser' ? 'bg-primary/20 font-bold' : 'bg-secondary'}`}
              title="Tẩy"
            >
              🧹
            </button>
          </div>
          {tool === 'pen' && (
            <div className="flex gap-0.5 md:gap-1 flex-wrap shrink-0">
              {COLORS.map(c => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  className={`w-6 h-6 md:w-7 md:h-7 rounded-full border-2 transition-transform ${color === c ? 'border-primary scale-110' : 'border-transparent'}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          )}
          <div className="flex gap-0.5 md:gap-1 ml-1 md:ml-2 shrink-0">
            {BRUSH_SIZES.map(s => (
              <button
                key={s}
                onClick={() => setBrushSize(s)}
                className={`w-7 h-7 md:w-8 md:h-8 rounded flex items-center justify-center ${brushSize === s ? 'bg-primary/20' : 'bg-secondary'}`}
              >
                <div className="rounded-full bg-current" style={{ width: s, height: s }} />
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={onUndo} className="ml-auto shrink-0" disabled={strokes.length === 0}>
            ↶
          </Button>
          <Button variant="outline" size="sm" onClick={onClear} className="shrink-0">
            Xóa
          </Button>
        </div>
      )}
    </div>
  );
}
