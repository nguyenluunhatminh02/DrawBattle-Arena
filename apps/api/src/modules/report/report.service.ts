import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ReportService {
  private readonly logger = new Logger(ReportService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(input: {
    targetType: string;
    targetId: string;
    reason: string;
    reporterId: string | null;
  }) {
    const report = await this.prisma.report.create({
      data: {
        reporterId: input.reporterId,
        targetType: input.targetType,
        targetId: input.targetId,
        reason: input.reason,
        status: 'PENDING',
      },
    });
    this.logger.warn(`New report ${report.id}: ${input.targetType}/${input.targetId} - ${input.reason.slice(0, 100)}`);
    return { reportId: report.id };
  }

  async list(status?: string) {
    return this.prisma.report.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async updateStatus(id: string, status: string, actorId: string | null, action?: string) {
    const report = await this.prisma.report.update({
      where: { id },
      data: { status },
    });
    if (action) {
      await this.prisma.moderationAction.create({
        data: {
          actorId,
          targetType: 'report',
          targetId: id,
          action,
          reason: `Report status -> ${status}`,
        },
      });
    }
    return report;
  }
}
