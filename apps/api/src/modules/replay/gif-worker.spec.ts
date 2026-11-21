import { renderSync } from './gif-worker';

// Importing the worker module must not render anything: only the real
// worker-thread entry point (parentPort + workerData) does that.
jest.mock('worker_threads', () => ({ parentPort: null, workerData: undefined }));

jest.mock('gif-encoder-2', () => {
  return jest.fn().mockImplementation(() => ({
    setDelay: jest.fn(),
    setRepeat: jest.fn(),
    setQuality: jest.fn(),
    start: jest.fn(),
    addFrame: jest.fn(),
    finish: jest.fn(),
    out: { getData: () => Buffer.from('gif') },
  }));
});

const createCanvas = jest.fn();
jest.mock('canvas', () => ({ createCanvas: (...args: any[]) => createCanvas(...args) }), { virtual: true });

interface Stroke {
  strokeId: string;
  points: Array<{ x: number; y: number }>;
  color: string;
  width: number;
}

function makeStroke(count: number): Stroke {
  return {
    strokeId: `s-${count}`,
    points: Array.from({ length: count }, (_, i) => ({ x: i / count, y: i / count })),
    color: '#000',
    width: 2,
  };
}

function setupCanvas() {
  const ctx = {
    fillRect: jest.fn(),
    beginPath: jest.fn(),
    arc: jest.fn(),
    fill: jest.fn(),
    stroke: jest.fn(),
    moveTo: jest.fn(),
    lineTo: jest.fn(),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineCap: '',
    lineJoin: '',
  };
  createCanvas.mockReturnValue({ getContext: () => ctx });
  return ctx;
}

const options = { width: 100, height: 100, fps: 10, backgroundColor: '#FFF' };

describe('gif-worker render loop', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupCanvas();
  });

  it('draws progressive stroke segments across frames', () => {
    const ctx = setupCanvas();

    renderSync({ strokes: [makeStroke(20)], durationMs: 5000, options });

    // 5 seconds at 10 fps = ~50 frames; each frame draws a prefix of the
    // stroke, starting with a single dot via arc and then paths with segments.
    expect(ctx.moveTo.mock.calls.length).toBeGreaterThan(40);
    expect(ctx.arc).toHaveBeenCalledTimes(2);
    expect(ctx.lineTo).toHaveBeenCalled();
    // Points are multiplied by the canvas width (100).
    expect(ctx.lineTo.mock.calls.some(([x]) => Math.abs(x - 95) < 0.0001)).toBe(true);
  });

  it('skips already-completed strokes without re-walking their points', () => {
    const ctx = setupCanvas();
    const strokes = Array.from({ length: 10 }, () => makeStroke(1000));

    renderSync({ strokes, durationMs: 5000, options });

    // Each frame must redraw all strokes revealed so far (the canvas is
    // cleared), so work grows with frames * revealed points. Cumulative
    // counts avoid re-summing stroke lengths; the hard cap keeps this bounded
    // at ~250k visits instead of the uncapped 500k for this replay.
    expect(ctx.lineTo.mock.calls.length).toBeLessThan(500_000);
    // Each of the 10 strokes starts one path per frame it is visible.
    expect(ctx.moveTo.mock.calls.length).toBeLessThanOrEqual(500);
  });

  it('caps multi-million-point replays within a bounded render budget', () => {
    const ctx = setupCanvas();
    const strokes = Array.from({ length: 20 }, () => makeStroke(100_000));

    renderSync({ strokes, durationMs: 5000, options });

    // 2M points would previously require ~100M point visits. After downsampling
    // to 120k across 50 progressive frames, the total is ~3M (vs ~100M).
    expect(ctx.lineTo.mock.calls.length).toBeLessThan(5_000_000);
    // Every frame draws at most one path per capped stroke.
    expect(ctx.moveTo.mock.calls.length).toBeLessThanOrEqual(20 * 50);
  });

  it('draws single-point strokes as circles', () => {
    const ctx = setupCanvas();

    renderSync({ strokes: [makeStroke(1)], durationMs: 500, options });

    expect(ctx.arc).toHaveBeenCalledTimes(5);
    expect(ctx.lineTo).not.toHaveBeenCalled();
  });

  it('handles empty strokes when scaling down huge replays', () => {
    const ctx = setupCanvas();
    const strokes = [makeStroke(0), makeStroke(200_000), makeStroke(0), makeStroke(200_000)];

    expect(() => renderSync({ strokes, durationMs: 5000, options })).not.toThrow();
    expect(ctx.lineTo.mock.calls.length).toBeLessThan(5_000_000);
  });
});
