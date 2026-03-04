import { Module } from '@nestjs/common';

import { PrismaModule } from './prisma/prisma.module';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule } from '@nestjs/config';
import { ConfigService } from '@nestjs/config';
import { WinstonModule } from 'nest-winston';
import { AuthModule } from './auth/auth.module';
import { PasswordService } from './password/password.service';
import { PasswordController } from './password/password.controller';
import { PasswordModule } from './password/password.module';
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
     JwtModule.registerAsync({
      global: true,
      
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => {
        console.log("JWT started")
        return {
          secret: configService.get<string>('JWT_SECRET') || 'default_secret',
          signOptions: { expiresIn: '24h' },
        }
      }
    }),
    AuthModule,
    PasswordModule
  ],
  controllers: [PasswordController],
  providers: [PasswordService],
})
export class AppModule {}
