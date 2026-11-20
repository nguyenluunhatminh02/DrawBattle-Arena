import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateRoomDto, RoomSettingsDto } from './room.dto';

describe('RoomSettingsDto (P1-03)', () => {
  async function errorsFor(settings: Record<string, unknown>) {
    const dto = plainToInstance(CreateRoomDto, { settings });
    return validate(dto, { whitelist: true, forbidNonWhitelisted: false });
  }

  it('rejects rounds=1000000', async () => {
    const errors = await errorsFor({ rounds: 1000000 });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('settings');
    expect(errors[0].children?.map(c => c.property)).toContain('rounds');
  });

  it('rejects non-integer and negative bounded settings', async () => {
    const errors = await errorsFor({
      maxPlayers: 1.5,
      turnDuration: -1,
      difficulty: 'IMPOSSIBLE',
      mode: 'CHAOS',
      enableHints: 'yes',
    });
    const fields = errors[0].children?.map(c => c.property) ?? [];
    expect(fields).toEqual(
      expect.arrayContaining(['maxPlayers', 'turnDuration', 'difficulty', 'mode', 'enableHints']),
    );
  });

  it('rejects empty or overlong passwords', async () => {
    expect((await errorsFor({ password: '' }))[0].children?.map(c => c.property)).toContain('password');
    expect((await errorsFor({ password: 'x'.repeat(65) }))[0].children?.map(c => c.property)).toContain('password');
  });

  it('rejects explicit null for every optional setting', async () => {
    const errors = await errorsFor({
      mode: null,
      maxPlayers: null,
      rounds: null,
      turnDuration: null,
      difficulty: null,
      enableHints: null,
      password: null,
      category: null,
    });
    const fields = errors[0].children?.map(c => c.property) ?? [];
    expect(fields).toEqual(
      expect.arrayContaining([
        'mode',
        'maxPlayers',
        'rounds',
        'turnDuration',
        'difficulty',
        'enableHints',
        'password',
        'category',
      ]),
    );
  });

  it('still accepts omitted settings and null settings object', async () => {
    expect(await validate(plainToInstance(CreateRoomDto, { settings: {} }))).toHaveLength(0);
    expect(await validate(plainToInstance(CreateRoomDto, { settings: null }))).toHaveLength(
      0,
    );
  });

  it('accepts a valid room settings payload', async () => {
    const dto = plainToInstance(RoomSettingsDto, {
      mode: 'CLASSIC',
      maxPlayers: 4,
      rounds: 2,
      turnDuration: 60,
      difficulty: 'MIXED',
      enableHints: true,
      password: 'secret123',
    });
    expect(await validate(dto)).toHaveLength(0);
  });
});
