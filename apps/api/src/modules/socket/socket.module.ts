import { Module } from '@nestjs/common';
import { GameSocketGateway } from './game-socket.gateway';
import { AuthModule } from '../auth/auth.module';
import { RoomModule } from '../room/room.module';
import { GameModule } from '../game/game.module';
import { RedisAdapterService } from './redis-adapter.service';

@Module({
  imports: [AuthModule, RoomModule, GameModule],
  providers: [GameSocketGateway, RedisAdapterService],
  exports: [RedisAdapterService],
})
export class SocketModule {}
