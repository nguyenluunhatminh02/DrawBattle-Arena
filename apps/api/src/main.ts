import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';

async function bootstrap() {
  if (!process.env.JWT_SECRET) {
    console.error('ERROR: JWT_SECRET environment variable is not set. Application cannot start.');
    process.exit(1);
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  const origins = (process.env.CORS_ORIGIN || 'http://localhost:3000')
    .split(',')
    .map(o => o.trim());
  app.enableCors({
    origin: origins,
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.setGlobalPrefix('api');
  app.useStaticAssets(join(process.cwd(), 'public'));

  const port = process.env.PORT || 3001;
  await app.listen(port);
  console.log(`API server running on http://localhost:${port}`);
}

bootstrap();
