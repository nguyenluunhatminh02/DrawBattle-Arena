import { Controller, Get, Post, Delete, Body, Param } from '@nestjs/common';
import { FeatureFlagService } from './feature-flag.service';
import { Throttle } from '../../common/throttle.guard';

@Controller('flags')
export class FeatureFlagController {
  constructor(private readonly flagService: FeatureFlagService) {}

  @Get()
  list() {
    return this.flagService.getAll();
  }

  @Get(':name')
  get(@Param('name') name: string) {
    return this.flagService.get(name);
  }

  @Post()
  @Throttle({ limit: 20, windowMs: 60_000, keyPrefix: 'flag-upsert' })
  upsert(@Body() body: { name: string; enabled: boolean; variant?: string }) {
    return this.flagService.upsert(body.name, body.enabled, body.variant);
  }

  @Delete(':name')
  remove(@Param('name') name: string) {
    return this.flagService.remove(name);
  }
}
