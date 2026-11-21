import {
  Controller,
  Get,
  Post,
  Param,
  HttpCode,
  HttpStatus,
  Headers,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { ReplayService, type ReplayReadContext } from './replay.service';
import { Throttle } from '../../common/throttle.guard';

@Controller('replays')
export class ReplayController {
  constructor(private readonly replayService: ReplayService) {}

  /**
   * The share link may be passed as `?share=<room code>` or in the
   * `x-share-token` header. A room code grants UNLISTED access; signed share
   * JWTs are verified by the service.
   */
  private readContext(
    authorization?: string,
    share?: string,
    shareHeader?: string,
  ): ReplayReadContext {
    return { authorization, shareToken: share || shareHeader };
  }

  // Specific routes must be declared before /:id so Nest does not shadow them.
  @Get('stats')
  @Throttle({ limit: 60, windowMs: 60_000, keyPrefix: 'replay-stats' })
  async stats() {
    return this.replayService.getStats();
  }

  @Get('turn/:turnId')
  @Throttle({ limit: 60, windowMs: 60_000, keyPrefix: 'replay-read' })
  async getByTurn(
    @Param('turnId') turnId: string,
    @Headers('authorization') authorization?: string,
    @Query('share') share?: string,
    @Headers('x-share-token') shareHeader?: string,
  ) {
    return this.replayService.getReplayByTurn(
      turnId,
      this.readContext(authorization, share, shareHeader),
    );
  }

  // Render status is cheap and can be polled after receiving 202 from /render.
  @Get(':id/render/status')
  @Throttle({ limit: 60, windowMs: 60_000, keyPrefix: 'replay-render-status' })
  async getRenderStatus(
    @Param('id') id: string,
    @Headers('authorization') authorization?: string,
    @Query('share') share?: string,
    @Headers('x-share-token') shareHeader?: string,
  ) {
    return this.replayService.getRenderStatus(
      id,
      this.readContext(authorization, share, shareHeader),
    );
  }

  @Get('jobs/:jobId')
  @Throttle({ limit: 60, windowMs: 60_000, keyPrefix: 'replay-job-status' })
  async getJobStatus(
    @Param('jobId') jobId: string,
    @Headers('authorization') authorization?: string,
    @Query('share') share?: string,
    @Headers('x-share-token') shareHeader?: string,
  ) {
    return this.replayService.getJobStatus(
      jobId,
      this.readContext(authorization, share, shareHeader),
    );
  }

  @Post(':id/render')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ limit: 3, windowMs: 60_000, keyPrefix: 'replay-render' })
  async queueRender(
    @Param('id') id: string,
    @Headers('authorization') authorization?: string,
    @Query('share') share?: string,
    @Headers('x-share-token') shareHeader?: string,
  ) {
    return this.replayService.queueRender(
      id,
      this.readContext(authorization, share, shareHeader),
    );
  }

  /** Guarded replacement for the former unauthenticated static GIF URL. */
  @Get('file/:id.gif')
  @Throttle({ limit: 60, windowMs: 60_000, keyPrefix: 'replay-read' })
  async getGifFile(
    @Param('id') id: string,
    @Headers('authorization') authorization?: string,
    @Query('share') share?: string,
    @Headers('x-share-token') shareHeader?: string,
  ): Promise<StreamableFile> {
    return this.replayService.streamGif(
      id,
      this.readContext(authorization, share, shareHeader),
    );
  }

  /**
   * Legacy /:id/gif alias streams directly: a redirect would drop the caller's
   * Authorization header and ?share token, breaking authorized private reads.
   */
  @Get(':id/gif')
  @Throttle({ limit: 60, windowMs: 60_000, keyPrefix: 'replay-read' })
  async getGif(
    @Param('id') id: string,
    @Headers('authorization') authorization?: string,
    @Query('share') share?: string,
    @Headers('x-share-token') shareHeader?: string,
  ): Promise<StreamableFile> {
    return this.replayService.getGif(
      id,
      this.readContext(authorization, share, shareHeader),
    );
  }

  @Get(':id')
  @Throttle({ limit: 60, windowMs: 60_000, keyPrefix: 'replay-read' })
  async getReplay(
    @Param('id') id: string,
    @Headers('authorization') authorization?: string,
    @Query('share') share?: string,
    @Headers('x-share-token') shareHeader?: string,
  ) {
    return this.replayService.getReplay(
      id,
      this.readContext(authorization, share, shareHeader),
    );
  }
}
