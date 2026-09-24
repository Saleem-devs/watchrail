import 'reflect-metadata';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { config as loadEnvironment } from 'dotenv';
import { AppModule } from './app.module.js';

loadEnvironment({ path: resolve(process.cwd(), '../../.env') });

const app = await NestFactory.createApplicationContext(AppModule);
app.enableShutdownHooks();

console.log('Watchrail worker running the check-outbox relay.');
