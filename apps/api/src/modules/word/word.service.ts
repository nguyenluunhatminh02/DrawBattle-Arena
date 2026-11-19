import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { pickWordOptions } from '@drawbattle/shared';
import type { WordDifficulty } from '@drawbattle/shared';

@Injectable()
export class WordService {
  constructor(private readonly prisma: PrismaService) {}

  async pickRandomWords(
    count: number,
    options?: { difficulty?: WordDifficulty | 'MIXED'; category?: string },
  ) {
    const where: Record<string, unknown> = { active: true };
    if (options?.difficulty && options.difficulty !== 'MIXED') {
      where.difficulty = options.difficulty;
    }
    if (options?.category) {
      where.category = { slug: options.category };
    }

    const words = await this.prisma.word.findMany({
      where,
      include: { category: true },
      take: Math.max(count * 5, 50),
    });

    return pickWordOptions(words, count).map(w => ({
      id: w.id,
      canonical: w.canonical,
      difficulty: w.difficulty,
      category: w.category.name,
    }));
  }

  async getWordById(id: string) {
    return this.prisma.word.findUnique({
      where: { id },
      include: { category: true },
    });
  }

  async incrementUsage(id: string) {
    return this.prisma.word.update({
      where: { id },
      data: { usageCount: { increment: 1 } },
    });
  }

  async getSynonyms(id: string): Promise<string[]> {
    const word = await this.prisma.word.findUnique({ where: { id } });
    if (!word) return [];
    return (word.synonyms as string[]) ?? [];
  }
}
