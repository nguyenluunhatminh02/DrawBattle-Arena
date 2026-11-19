import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsString, Length } from 'class-validator';
import { ReportService } from './report.service';
import { GuestGuard } from '../auth/guest.guard';
import type { Request } from 'express';

interface GuestRequest extends Request {
  guest?: { sessionId: string; nickname: string };
}

export class CreateReportDto {
  @IsString()
  targetType!: string;

  @IsString()
  targetId!: string;

  @IsString()
  @Length(1, 500)
  reason!: string;
}

export class UpdateReportDto {
  @IsString()
  status!: string;

  @IsString()
  action?: string;
}

@Controller('reports')
export class ReportController {
  constructor(private readonly report: ReportService) {}

  @Post()
  @UseGuards(GuestGuard)
  create(@Body() dto: CreateReportDto, @Req() req: GuestRequest) {
    return this.report.create({
      targetType: dto.targetType,
      targetId: dto.targetId,
      reason: dto.reason,
      reporterId: req.guest?.sessionId ?? null,
    });
  }

  @Get()
  list(@Query('status') status?: string) {
    return this.report.list(status);
  }

  @Patch(':id')
  @UseGuards(GuestGuard)
  update(@Param('id') id: string, @Body() dto: UpdateReportDto, @Req() req: GuestRequest) {
    return this.report.updateStatus(id, dto.status, req.guest?.sessionId ?? null, dto.action);
  }
}
