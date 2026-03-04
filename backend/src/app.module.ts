import { Module } from '@nestjs/common';

import { PrismaModule } from './prisma/prisma.module';

import { ConfigModule } from '@nestjs/config';
import { WinstonModule } from 'nest-winston';
import { AuthModule } from './auth/auth.module';
import * as winston from 'winston';
import 'winston-daily-rotate-file';

@Module({
  imports: [ 
    ConfigModule.forRoot({
      isGlobal: true
    }),
    PrismaModule,
    WinstonModule.forRoot({
      transports: [
       new winston.transports.Console({
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.colorize(),
            winston.format.printf(({ timestamp, level, message, context }) => {
              return `${timestamp} [${context || 'App'}] ${level}: ${message}`;
            }),
          ),
        }),
        new winston.transports.DailyRotateFile({
          filename: 'logs/%DATE%-error.log',
          datePattern: 'YYYY-MM-DD',
          level: 'error',
          maxSize: '20m',
          maxFiles: '30d',
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.json(),
          ),
        }),

      ]
    }),
    AuthModule
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
