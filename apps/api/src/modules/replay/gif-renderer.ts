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

interface RenderOptions {
  width: number;
  height: number;
  fps: number;
  backgroundColor: string;
}

const MAX_FRAMES = 120;
const MAX_FPS = 10;
const MAX_DURATION_MS = 60_000;

export async function renderStrokesToGif(
  strokes: Stroke[],
  durationMs: number,
  options: RenderOptions,
): Promise<Buffer> {
  if (!createCanvas) {
    throw new Error('canvas module not available - install native dependencies');
  }
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

  const totalPoints = strokes.reduce((sum, s) => sum + s.points.length, 0);

  for (let frame = 0; frame < totalFrames; frame++) {
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, width, height);

    const target = Math.min(
      totalPoints,
      Math.ceil(((frame + 1) / totalFrames) * totalPoints),
    );
    drawStrokesUpTo(ctx, strokes, target, width, height);
    encoder.addFrame(ctx);

    if (frame % 10 === 9) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  encoder.finish();
  return encoder.out.getData();
}

function drawStrokesUpTo(
  ctx: any,
  strokes: Stroke[],
  maxPoints: number,
  canvasWidth: number,
  canvasHeight: number,
) {
  let pointsDrawn = 0;

  for (const stroke of strokes) {
    if (pointsDrawn >= maxPoints) break;
    if (stroke.points.length === 0) continue;

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
