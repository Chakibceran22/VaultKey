import { ConflictException, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { Inject } from '@nestjs/common';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston/dist/winston.constants';
import { DomainDTO } from './dtos/DomainDTO';
import { Prisma } from 'generated/prisma/client'

@Injectable()
export class DomainService {
    constructor(
        private readonly prisma: PrismaService,
        @Inject(WINSTON_MODULE_NEST_PROVIDER) private readonly logger: Logger
    ) { }

    async registerDomain(domainDTO: DomainDTO) {
        try {
            const domain = await this.prisma.domain.create({
                data: { name: domainDTO.name }
            })

            this.logger.log(`Domain ${domainDTO.name} registered successfully`, { context: 'DomainService' });
            return { success: true }

        } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
                const field = (error.meta?.target as string[])?.[0] ?? 'field'
                throw new ConflictException(`This ${field} already exists`)
            }

            this.logger.error(`Error in registerDomain: ${error.message}`, { context: 'DomainService' });
            throw new InternalServerErrorException('Failed to register domain');
        }
    }


    async fetchDomains() {
        try {
            const domains = await this.prisma.domain.findMany({
                include: { _count: { select: { credentials: true } } }
            })

            this.logger.log(`Fetched ${domains.length} domains`, { context: 'DomainService' });
            return {
                domains
            }
        } catch (error) {
            throw new InternalServerErrorException('Failed to fetch domains');
        }
    }


    async deleteDomain(domainId: number) {
        try {
            const deleted = await this.prisma.domain.delete({
                where: { id: domainId }
            })
            return { success: !!deleted }
        } catch (error) {
            this.logger.error(`Error in deleteDomain: ${error.message}`, { context: 'DomainService' });
            throw new InternalServerErrorException('Failed to delete domain');
        }
    }
}
