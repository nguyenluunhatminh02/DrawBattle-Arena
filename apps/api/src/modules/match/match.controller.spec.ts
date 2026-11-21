import { Reflector } from '@nestjs/core';
import { THROTTLE_KEY, ThrottleConfig } from '../../common/throttle.guard';
import { MatchController } from './match.controller';
import { MatchService } from './match.service';

describe('MatchController', () => {
  const service = {
    listMatches: jest.fn().mockResolvedValue({ matches: [] }),
    getMatch: jest.fn().mockResolvedValue({ id: 'm1' }),
    getMatchResults: jest.fn().mockResolvedValue({ matchId: 'm1' }),
  } as unknown as MatchService;
  const controller = new MatchController(service);
  const reflector = new Reflector();

  it('publishes explicit throttle configs on all public match routes', () => {
    for (const handler of [controller.list, controller.details, controller.results]) {
      const config = reflector.get<ThrottleConfig>(THROTTLE_KEY, handler);
      expect(config).toMatchObject({
        limit: expect.any(Number),
        windowMs: expect.any(Number),
        keyPrefix: expect.any(String),
      });
    }
  });

  it('clamps list limit and offset before calling the service', () => {
    controller.list('9999', '999999');
    expect(service.listMatches).toHaveBeenCalledWith(50, 10_000);

    controller.list('-5', '-20');
    expect(service.listMatches).toHaveBeenLastCalledWith(20, 0);

    controller.list(undefined, undefined);
    expect(service.listMatches).toHaveBeenLastCalledWith(20, 0);
  });
});
