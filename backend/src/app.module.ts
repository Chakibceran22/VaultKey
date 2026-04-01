import { Module } from '@nestjs/common';
import LokiTransport from 'winston-loki';
import { PrismaModule } from './prisma/prisma.module';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule } from '@nestjs/config';
import { ConfigService } from '@nestjs/config';
import { WinstonModule } from 'nest-winston';
import { AuthModule } from './auth/auth.module';
import { CredentialModule } from './credential/credential.module';
import { DomainModule } from './domain/domain.module';
import * as winston from 'winston';
import 'winston-daily-rotate-file';
import { configSchema } from './common/config/config-module.config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';

@Module({
  imports: [
    ConfigModule.forRoot({
      validationSchema: configSchema,
      isGlobal: true
    }),
    PrismaModule,
    WinstonModule.forRoot({
      transports: [
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.colorize(),
            winston.format.printf(({ timestamp, level, message, context, ...meta }) => {
              return `${timestamp} [${context || 'App'}] ${level}: ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''
                }`;
            })
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
        new LokiTransport({
          host: process.env.LOKI_URL || 'http://localhost:3100',
          labels: { app: 'vaultkey-backend' },
        })

      ]
    }),
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        return {
          secret: configService.getOrThrow<string>('JWT_SECRET'),
          signOptions: {
            expiresIn: configService.getOrThrow<string>('JWT_EXPIRES_IN') as `${number}${'s' | 'm' | 'h' | 'd'}`,
          },
        };
      },
    }),
    ThrottlerModule.forRoot([{
      name: "short",
      ttl: 1000,
      limit: 5
    }, {
      name: "long",
      ttl: 60 * 1000,
      limit: 100
    }]),
    AuthModule,
    CredentialModule,
    DomainModule
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    }
  ],
})
export class AppModule { }
