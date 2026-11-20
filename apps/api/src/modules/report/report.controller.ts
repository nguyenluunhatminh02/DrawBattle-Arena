import { Body, Controller, Get, Param, Patch, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { IsIn, IsString, Length, MaxLength } from 'class-validator';
import { ReportService } from './report.service';
import { OptionalAuthGuard } from '../auth/optional-auth.guard';
import { AdminGuard } from '../../common/admin.guard';
import { Throttle } from '../../common/throttle.guard';
import type { Request } from 'express';

interface IdentityRequest extends Request {
  guest?: { sessionId: string; nickname: string };
  user?: { id: string; nickname?: string };
}

const REPORT_STATUSES = ['PENDING', 'REVIEWING', 'RESOLVED', 'DISMISSED'] as const;

export class CreateReportDto {
  @IsString()
  @Length(1, 32)
  targetType!: string;

  @IsString()
  @Length(1, 128)
  targetId!: string;

  @IsString()
  @Length(1, 500)
  @MaxLength(500)
  reason!: string;
}

export class UpdateReportDto {
  @IsIn(REPORT_STATUSES)
  status!: string;

  @IsString()
  @Length(1, 64)
  action?: string;
}

@Controller('reports')
export class ReportController {
  constructor(private readonly report: ReportService) {}

  @Post()
  @UseGuards(OptionalAuthGuard)
  @Throttle({ limit: 5, windowMs: 60_000, keyPrefix: 'report-create' })
  create(@Body() dto: CreateReportDto, @Req() req: IdentityRequest) {
    const reporterId = req.user?.id ?? req.guest?.sessionId ?? null;
    if (!reporterId) {
      throw new UnauthorizedException('Guest or user token required');
    }
    return this.report.create({
      targetType: dto.targetType,
      targetId: dto.targetId,
      reason: dto.reason,
      reporterId,
    });
  }

  @Get()
  @UseGuards(AdminGuard)
  list(@Query('status') status?: string) {
    return this.report.list(status);
  }

  @Patch(':id')
  @UseGuards(AdminGuard)
  update(@Param('id') id: string, @Body() dto: UpdateReportDto, @Req() req: any) {
    return this.report.updateStatus(id, dto.status, req.user?.id ?? null, dto.action);
  }
}
