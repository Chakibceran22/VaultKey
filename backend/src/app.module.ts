import { Module } from '@nestjs/common';

import { PrismaModule } from './prisma/prisma.module';

import { InitService } from './init/init.service';
import { InitModule } from './init/init.module';
import { ConfigModule } from '@nestjs/config';
import { PasswordModule } from './password/password.module';

@Module({
  imports: [ InitModule,
    ConfigModule.forRoot({
      isGlobal: true
    }),
    PasswordModule,
    PrismaModule
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
