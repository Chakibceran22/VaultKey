import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { LoggerService } from '@nestjs/common';
import { PrismaClient } from 'generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy { 
    
    constructor(
        @Inject(WINSTON_MODULE_NEST_PROVIDER) private readonly logger: LoggerService
    ) {
        const adapter = new PrismaPg({
            connectionString: process.env.DATABASE_URL as string,
        });
        super({ adapter });
        
    }

    async onModuleInit() {
        try {
            await this.$connect();
            this.logger.log('Connected to the database successfully.');
        } catch (error) {
            console.error("Error connecting to the database:", error);
            this.logger.error('Failed to connect to the database.', error);
        }
    }

    async onModuleDestroy() {
        await this.$disconnect();
    }
}
