import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

function corsOrigins(): string[] {
  return (process.env.CORS_ORIGIN || 'http://localhost:3000,http://127.0.0.1:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  const allowed = corsOrigins();
  if (allowed.includes(origin)) return true;
  if (process.env.CORS_ALLOW_VERCEL === 'true') {
    if (/^https:\/\/[\w.-]+\.vercel\.app$/i.test(origin)) return true;
  }
  return false;
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.enableCors({
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) callback(null, true);
      else callback(null, false);
    },
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      exceptionFactory: (errors) => new BadRequestException(errors),
    }),
  );
  const config = new DocumentBuilder()
    .setTitle('Soft Drink Distribution API')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));

  const port = Number(process.env.PORT || 4000);
  await app.listen(port, '0.0.0.0');
}

bootstrap();
