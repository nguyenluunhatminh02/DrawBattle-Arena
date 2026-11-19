import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class FeatureFlagService {
  constructor(private readonly prisma: PrismaService) {}

  async getAll() {
    return this.prisma.featureFlag.findMany({ orderBy: { name: 'asc' } });
  }

  async get(name: string) {
    const flag = await this.prisma.featureFlag.findUnique({ where: { name } });
    if (!flag) throw new NotFoundException(`Feature flag '${name}' not found`);
    return flag;
  }

  async find(name: string) {
    return this.prisma.featureFlag.findUnique({ where: { name } });
  }

  async upsert(name: string, enabled: boolean, variant?: string) {
    return this.prisma.featureFlag.upsert({
      where: { name },
      update: { enabled, variant: variant ?? null },
      create: { name, enabled, variant: variant ?? null },
    });
  }

  async remove(name: string) {
    const flag = await this.prisma.featureFlag.findUnique({ where: { name } });
    if (!flag) throw new NotFoundException(`Feature flag '${name}' not found`);
    await this.prisma.featureFlag.delete({ where: { name } });
    return { deleted: name };
  }

  async isEnabled(name: string): Promise<boolean> {
    const flag = await this.prisma.featureFlag.findUnique({ where: { name } });
    return flag?.enabled ?? false;
  }
}
