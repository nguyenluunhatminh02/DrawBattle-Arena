declare module 'gif-encoder-2' {
  class GIFEncoder {
    constructor(width: number, height: number, algorithm?: string, useOptimizer?: boolean);
    readonly out: { getData(): Buffer };
    setDelay(ms: number): void;
    setRepeat(repeat: number): void;
    setQuality(quality: number): void;
    setTransparent(color: string | null): void;
    start(): void;
    addFrame(ctx: unknown): void;
    finish(): void;
  }

  export = GIFEncoder;
}
