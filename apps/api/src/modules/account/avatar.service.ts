import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import sharp from 'sharp';
import { join } from 'path';
import { mkdir, writeFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';

@Injectable()
export class AvatarService {
  private readonly uploadDir = join(process.cwd(), 'public', 'avatars');
  private readonly maxSize = 5 * 1024 * 1024; // 5MB
  private readonly allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];

  constructor(private readonly prisma: PrismaService) {}

  async uploadAvatar(userId: string, file: Express.Multer.File): Promise<string> {
    // Validate file
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    if (file.size > this.maxSize) {
      throw new BadRequestException('File too large (max 5MB)');
    }

    if (!this.allowedTypes.includes(file.mimetype)) {
      throw new BadRequestException('Invalid file type (only JPEG, PNG, WebP allowed)');
    }

    // Ensure upload directory exists
    if (!existsSync(this.uploadDir)) {
      await mkdir(this.uploadDir, { recursive: true });
    }

    // Generate unique filename
    const ext = file.mimetype.split('/')[1];
    const filename = `${userId}-${Date.now()}.${ext}`;
    const filepath = join(this.uploadDir, filename);

    // Process image: resize to 200x200, convert to WebP for optimization
    try {
      await sharp(file.buffer)
        .resize(200, 200, { fit: 'cover' })
        .webp({ quality: 85 })
        .toFile(filepath.replace(`.${ext}`, '.webp'));

      const avatarUrl = `/avatars/${filename.replace(`.${ext}`, '.webp')}`;

      // Delete old avatar if exists
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      if (user?.avatar) {
        const oldPath = join(process.cwd(), 'public', user.avatar);
        if (existsSync(oldPath)) {
          await unlink(oldPath).catch(() => {});
        }
      }

      // Update user record
      await this.prisma.user.update({
        where: { id: userId },
        data: { avatar: avatarUrl },
      });

      return avatarUrl;
    } catch (err) {
      throw new BadRequestException('Failed to process image');
    }
  }

  async deleteAvatar(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.avatar) return;

    const filepath = join(process.cwd(), 'public', user.avatar);
    if (existsSync(filepath)) {
      await unlink(filepath).catch(() => {});
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { avatar: null },
    });
  }
}
