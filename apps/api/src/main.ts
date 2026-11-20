import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';

async function bootstrap() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32 || secret === 'change-me-in-production' || secret === 'change-me-to-a-random-64-char-hex-string') {
    console.error('ERROR: JWT_SECRET must be set to a random string of at least 32 characters. Application cannot start.');
    process.exit(1);
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // The API runs behind a Next.js rewrite in production and behind a Cloudflare
  // tunnel in deployment. Express must trust the configured proxy hop count so
  // req.ip is derived from trusted X-Forwarded-For processing rather than the
  // raw socket address; otherwise every user shares one rate-limit bucket.
  // TRUST_PROXY env is always a string; parse numeric hop counts correctly.
  const trustProxy = process.env.TRUST_PROXY;
  const parsedTrustProxy = trustProxy
    ? (Number.isNaN(Number(trustProxy)) ? trustProxy : Number(trustProxy))
    : 1;
  app.set('trust proxy', parsedTrustProxy);

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
      forbidNonWhitelisted: false,
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
