import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ModerationService {
  constructor(private readonly prisma: PrismaService) {}

  async getReports(status?: string, limit = 50) {
    return this.prisma.report.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 100),
    });
  }

  async updateReport(reportId: string, status: string, action?: string, reason?: string) {
    const report = await this.prisma.report.findUnique({ where: { id: reportId } });
    if (!report) throw new NotFoundException('Report not found');

    const updated = await this.prisma.report.update({
      where: { id: reportId },
      data: { status },
    });

    if (action) {
      await this.prisma.moderationAction.create({
        data: {
          targetType: report.targetType,
          targetId: report.targetId,
          action,
          reason: reason ?? null,
        },
      });
    }

    return updated;
  }

  async getActions(limit = 50) {
    return this.prisma.moderationAction.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 100),
    });
  }

  async getStats() {
    const totalReports = await this.prisma.report.count();
    const pending = await this.prisma.report.count({ where: { status: 'PENDING' } });
    const resolved = await this.prisma.report.count({ where: { status: 'RESOLVED' } });
    const totalActions = await this.prisma.moderationAction.count();
    return { totalReports, pending, resolved, totalActions };
  }
}
