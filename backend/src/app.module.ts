import { Module } from '@nestjs/common';

import { PrismaModule } from './prisma/prisma.module';

import { InitModule } from './init/init.module';
import { ConfigModule } from '@nestjs/config';
import { PasswordModule } from './password/password.module';
import { WinstonModule } from 'nest-winston';
import * as winston from 'winston';
import 'winston-daily-rotate-file';

@Module({
  imports: [ InitModule,
    ConfigModule.forRoot({
      isGlobal: true
    }),
    PasswordModule,
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
    })
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
