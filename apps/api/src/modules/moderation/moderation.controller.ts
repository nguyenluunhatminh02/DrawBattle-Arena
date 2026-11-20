import { Controller, Get, Patch, Body, Param, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { ModerationService } from './moderation.service';
import { AdminGuard } from '../../common/admin.guard';

const MODERATION_STATUSES = ['PENDING', 'REVIEWING', 'RESOLVED', 'DISMISSED'] as const;

export class UpdateModerationReportDto {
  @IsIn(MODERATION_STATUSES)
  status!: string;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  action?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

@Controller('moderation')
@UseGuards(AdminGuard)
export class ModerationController {
  constructor(private readonly moderationService: ModerationService) {}

  @Get('reports')
  getReports(@Query('status') status?: string, @Query('limit') limit?: string) {
    return this.moderationService.getReports(status, limit ? parseInt(limit, 10) : 50);
  }

  @Patch('reports/:id')
  updateReport(
    @Param('id') id: string,
    @Body() body: UpdateModerationReportDto,
  ) {
    return this.moderationService.updateReport(id, body.status, body.action, body.reason);
  }

  @Get('actions')
  getActions(@Query('limit') limit?: string) {
    return this.moderationService.getActions(limit ? parseInt(limit, 10) : 50);
  }

  @Get('stats')
  getStats() {
    return this.moderationService.getStats();
  }
}
