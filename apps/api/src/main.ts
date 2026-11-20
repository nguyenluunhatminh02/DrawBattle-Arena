import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';
import { AccountBodyValidationGuard } from './common/account-body-validation.guard';
import { parseTrustProxy } from './trust-proxy';

async function bootstrap() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32 || secret === 'change-me-in-production' || secret === 'change-me-to-a-random-64-char-hex-string') {
    console.error('ERROR: JWT_SECRET must be set to a random string of at least 32 characters. Application cannot start.');
    process.exit(1);
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // TRUST_PROXY must be opt-in: trusting forwarded headers by default lets a
  // direct caller spoof X-Forwarded-For and bypass per-IP rate limits. Compose
  // and tunnel deployments set the trusted hop count explicitly; the safe
  // default (0 / false) uses the raw socket address.
  app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));

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
  // /account/login and /account/register have inline body types in their
  // controller; this guard applies class-validator DTOs to those two routes.
  app.useGlobalGuards(new AccountBodyValidationGuard());

  app.setGlobalPrefix('api');
  app.useStaticAssets(join(process.cwd(), 'public'));

  const port = process.env.PORT || 3001;
  await app.listen(port);
  console.log(`API server running on http://localhost:${port}`);
}

bootstrap();
