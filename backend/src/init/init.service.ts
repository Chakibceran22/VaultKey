import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2'
@Injectable()
export class InitService implements OnModuleInit {
    constructor(
        private readonly prisma: PrismaService,
        private readonly configService: ConfigService
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
            console.log("Password already set")
            return
        }
        const masterPassword = this.getMasterPassword();
        if(!masterPassword) {
             throw new Error("Master Password is not set in the env file")
        }
        const hashMasterPassword = await argon2.hash(masterPassword);
        await this.prisma.masterPassword.create({
            data: {hash: hashMasterPassword}
        })
        console.log("Master password created in the DB")
        return
    }
    async onModuleInit() {
        await this.initDB()
    }






}
