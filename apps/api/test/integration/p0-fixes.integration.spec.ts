import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ChallengeService } from '../../src/modules/challenge/challenge.service';
import { RoomService } from '../../src/modules/room/room.service';
import { INestApplication } from '@nestjs/common';

describe('P0 Fixes Integration Tests', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let challengeService: ChallengeService;
  let roomService: RoomService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);
    challengeService = moduleFixture.get<ChallengeService>(ChallengeService);
    roomService = moduleFixture.get<RoomService>(RoomService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('P0-PasswordHash: Room password hash not leaked', () => {
    it('should not return passwordHash in getRoomInfo', async () => {
      const room = await roomService.createRoom('TestHost', 'session1', null, {
        password: 'secret123',
        maxPlayers: 4,
      });

      const info = await roomService.getRoomInfo(room.roomCode);

      expect(info.hasPassword).toBe(true);
      expect(info.settings).not.toHaveProperty('password');
      expect(info.settings).not.toHaveProperty('passwordHash');

      await prisma.room.delete({ where: { id: room.roomId } });
    });
  });

  describe('P0-Finalize: Challenge finalize requires authentication', () => {
    it('should reject anonymous finalize request', async () => {
      const challenge = await prisma.challenge.create({
        data: {
          wordId: (await prisma.word.findFirst())!.id,
          expiresAt: new Date(Date.now() + 3600_000),
          creatorSessionId: 'owner_session',
        },
      });

      await expect(
        challengeService.finalize(
          challenge.id,
          [{ strokeId: 's1', points: [{ x: 0, y: 0 }], color: '#000000', width: 2 }],
          5000,
          undefined,
        ),
      ).rejects.toThrow('Authentication required to finalize');

      await prisma.challenge.delete({ where: { id: challenge.id } });
    });

    it('should reject non-owner finalize request', async () => {
      const challenge = await prisma.challenge.create({
        data: {
          wordId: (await prisma.word.findFirst())!.id,
          expiresAt: new Date(Date.now() + 3600_000),
          creatorSessionId: 'owner_session',
        },
      });

      await expect(
        challengeService.finalize(
          challenge.id,
          [{ strokeId: 's1', points: [{ x: 0, y: 0 }], color: '#000000', width: 2 }],
          5000,
          { sessionId: 'other_session' },
        ),
      ).rejects.toThrow('Only the creator can finalize');

      await prisma.challenge.delete({ where: { id: challenge.id } });
    });
  });

  describe('P0-DI: NestJS dependency injection', () => {
    it('should initialize all modules without errors', () => {
      expect(app).toBeDefined();
      expect(prisma).toBeDefined();
      expect(challengeService).toBeDefined();
      expect(roomService).toBeDefined();
    });
  });
});
