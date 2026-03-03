import { Inject, Injectable, Logger,  OnModuleInit } from '@nestjs/common';
import type { LoggerService } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2'
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston/dist/winston.constants';
@Injectable()
export class InitService implements OnModuleInit {
    constructor(
        private readonly prisma: PrismaService,
        private readonly configService: ConfigService,
        @Inject(WINSTON_MODULE_NEST_PROVIDER) private readonly logger: LoggerService
    ){}

    getMasterPassword() {
        return this.configService.get<string>('MASTER_PASSWORD');
    }

    async isInitialized() {
        const existing = await this.prisma.masterPassword.findFirst({})
        return existing !== null 
    }

    async initDB() {
        if(await this.isInitialized()) {
            this.logger.log("Password already set", InitService.name)
            return
        }
        const masterPassword = this.getMasterPassword();
        if(!masterPassword) {
            this.logger.error("Master Password is not set in the env file")
             throw new Error("Master Password is not set in the env file")
        }
        const hashMasterPassword = await argon2.hash(masterPassword);
        await this.prisma.masterPassword.create({
            data: {hash: hashMasterPassword}
        })
        this.logger.log("Master password created in the DB")
        return
    }
    async onModuleInit() {
        await this.initDB()
    }






}
