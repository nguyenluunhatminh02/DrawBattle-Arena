import { parentPort, workerData } from 'worker_threads';
import GIFEncoder = require('gif-encoder-2');

let createCanvas: ((w: number, h: number) => any) | null = null;
try {
  createCanvas = require('canvas').createCanvas;
} catch {
  createCanvas = null;
}

interface Stroke {
  strokeId: string;
  points: Array<{ x: number; y: number }>;
  color: string;
  width: number;
}

interface RenderJob {
  strokes: Stroke[];
  durationMs: number;
  options: {
    width: number;
    height: number;
    fps: number;
    backgroundColor: string;
  };
}

const MAX_FRAMES = 120;
const MAX_FPS = 10;
const MAX_DURATION_MS = 60_000;
const MAX_TOTAL_POINTS = 120_000;

/**
 * Keep at most maxPoints across all strokes, thinning each stroke evenly so
 * the drawing still resembles the original replay. Skips empty strokes.
 */
function capStrokes(strokes: Stroke[], maxPoints: number): Stroke[] {
  const total = strokes.reduce((sum, s) => sum + s.points.length, 0);
  if (total <= maxPoints) return strokes;

  const scale = maxPoints / total;
  const capped: Stroke[] = [];
  let remaining = maxPoints;
  for (const stroke of strokes) {
    if (remaining <= 0) break;
    if (stroke.points.length === 0) continue;
    const keep = Math.max(
      1,
      Math.min(stroke.points.length, Math.round(stroke.points.length * scale), remaining),
    );
    const step = stroke.points.length / keep;
    const points = Array.from({ length: keep }, (_, i) => stroke.points[Math.floor(i * step)]);
    capped.push({ ...stroke, points });
    remaining -= keep;
  }
  return capped;
}

export function renderSync(job: RenderJob): Buffer {
  if (!createCanvas) {
    throw new Error('canvas module not available');
  }
  const { strokes, durationMs, options } = job;
  const { width, height, backgroundColor } = options;
  const fps = Math.min(options.fps, MAX_FPS);
  const safeDuration = Math.max(500, Math.min(durationMs || 0, MAX_DURATION_MS));
  const totalFrames = Math.max(
    1,
    Math.min(MAX_FRAMES, Math.floor((safeDuration / 1000) * fps)),
  );
  const frameDelay = Math.max(20, Math.round(safeDuration / totalFrames));

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const encoder = new GIFEncoder(width, height);
  encoder.setDelay(frameDelay);
  encoder.setRepeat(0);
  encoder.setQuality(10);
  encoder.start();

  // Downsample huge replays once so the render loop has a hard bound on the
  // number of points it can visit. Without this, frames * totalPoints work
  // can time out the worker on a malicious/accidental drawing.
  const drawStrokes = capStrokes(strokes, MAX_TOTAL_POINTS);
  const cumulativePointCounts: number[] = [];
  let totalPoints = 0;
  for (const stroke of drawStrokes) {
    totalPoints += stroke.points.length;
    cumulativePointCounts.push(totalPoints);
  }

  for (let frame = 0; frame < totalFrames; frame++) {
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, width, height);

    const target = Math.min(
      totalPoints,
      Math.ceil(((frame + 1) / totalFrames) * totalPoints),
    );
    drawStrokesUpTo(ctx, drawStrokes, cumulativePointCounts, target, width, height);
    encoder.addFrame(ctx);
  }

  encoder.finish();
  return encoder.out.getData();
}

function drawStrokesUpTo(
  ctx: any,
  strokes: Stroke[],
  cumulativePointCounts: number[],
  maxPoints: number,
  canvasWidth: number,
  canvasHeight: number,
) {
  let pointsDrawn = 0;

  for (let strokeIndex = 0; strokeIndex < strokes.length; strokeIndex++) {
    const stroke = strokes[strokeIndex];
    if (pointsDrawn >= maxPoints) break;
    if (stroke.points.length === 0) continue;

    // Precomputed cumulative counts let the loop skip strokes that cannot
    // contribute to this frame in O(1), instead of summing lengths per frame.
    if (cumulativePointCounts[strokeIndex] <= pointsDrawn) continue;
    const remaining = maxPoints - pointsDrawn;
    const pointsToDraw = Math.min(stroke.points.length, remaining);

    if (pointsToDraw === 1) {
      ctx.beginPath();
      ctx.fillStyle = stroke.color;
      ctx.arc(stroke.points[0].x * canvasWidth, stroke.points[0].y * canvasHeight, stroke.width / 2, 0, Math.PI * 2);
      ctx.fill();
      pointsDrawn += 1;
      continue;
    }

    ctx.beginPath();
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const first = stroke.points[0];
    ctx.moveTo(first.x * canvasWidth, first.y * canvasHeight);

    for (let i = 1; i < pointsToDraw; i++) {
      const p = stroke.points[i];
      ctx.lineTo(p.x * canvasWidth, p.y * canvasHeight);
    }

    ctx.stroke();
    pointsDrawn += pointsToDraw;
  }
}

if (parentPort && workerData) {
  try {
    const buf = renderSync(workerData as RenderJob);
    parentPort.postMessage(buf);
  } catch (err) {
    parentPort.postMessage({ error: err instanceof Error ? err.message : String(err) });
  }
}
