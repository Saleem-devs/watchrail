import 'reflect-metadata';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { config as loadEnvironment } from 'dotenv';
import { AppModule } from './app.module.js';
import { APP_CONFIG, type AppConfig } from './config.js';

loadEnvironment({ path: resolve(process.cwd(), '../../.env') });

// The platform parser is disabled so Better Auth can read its raw request
// stream. AppModule installs bounded JSON/form parsers after the Better Auth
// middleware for all normal Nest controllers.
const app = await NestFactory.create(AppModule, { bodyParser: false });

app.setGlobalPrefix('api');
app.enableShutdownHooks();

const config = app.get<AppConfig>(APP_CONFIG);

// Enable CORS for Next.js frontend in development.
// In production, the frontend proxies /api/* through its own server, so the
// CORS origin should be configured to match the public deployment URL.
app.enableCors({
  origin: config.frontendOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cookie'],
});

await app.listen(config.port);

console.log(`Watchrail API listening on http://localhost:${config.port}/api`);
