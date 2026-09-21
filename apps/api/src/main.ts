import 'reflect-metadata';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { config as loadEnvironment } from 'dotenv';
import { AppModule } from './app.module.js';
import { APP_CONFIG, type AppConfig } from './config.js';

loadEnvironment({ path: resolve(process.cwd(), '../../.env') });

const app = await NestFactory.create(AppModule);
app.setGlobalPrefix('api');
app.enableShutdownHooks();

const config = app.get<AppConfig>(APP_CONFIG);
await app.listen(config.port);

console.log(`Watchrail API listening on http://localhost:${config.port}/api`);
