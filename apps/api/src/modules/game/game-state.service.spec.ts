import { GameStateService } from './game-state.service';

function makeService(): GameStateService {
  // addPlayer/initRoom are pure in-memory operations and do not use these
  // collaborators, so lightweight stubs keep this regression test focused.
  return new GameStateService({} as never, {} as never, {} as never);
}

describe('GameStateService.addPlayer', () => {
  it('allows an existing player to reconnect when the room is full', () => {
    const service = makeService();
    service.initRoom('room-1', 'host', 'Host', {
      mode: 'CLASSIC',
      maxPlayers: 2,
      rounds: 1,
      turnDuration: 60,
      difficulty: 'MIXED',
      enableHints: true,
    } as never);

    expect(service.addPlayer('room-1', 'guest', 'Guest')).not.toBeNull();
    expect(service.addPlayer('room-1', 'third', 'Third')).toBeNull();

    const reconnected = service.addPlayer('room-1', 'guest', 'Guest');
    expect(reconnected).not.toBeNull();
    expect(reconnected?.id).toBe('guest');
    expect(reconnected?.isOnline).toBe(true);
  });
});
