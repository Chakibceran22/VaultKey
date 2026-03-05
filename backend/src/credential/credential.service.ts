import { ConflictException, Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateCredentialsDTO } from './dtos/Credentials.dto';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston/dist/winston.constants';
import { Prisma } from 'generated/prisma/client'  // ✅ server client, not browser

@Injectable()
export class CredentialService {
    constructor(
        private readonly prisma: PrismaService,
        @Inject(WINSTON_MODULE_NEST_PROVIDER) private readonly logger: Logger
    ){}

    async createCredential(CredentialDTO: CreateCredentialsDTO) {
        try {
            const { username, email, password, domainId } = CredentialDTO;

            const newCredential = await this.prisma.credential.create({
                data: { username, email, password, domainId }
            })

            if (newCredential) return { success: true }
            return { success: false }

        } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
                const field = (error.meta?.target as string[])?.[0] ?? 'field'
                throw new ConflictException(`This ${field} is already in use`)
            }

            this.logger.error(`Error in createCredential: ${error.message}`, { context: 'CredentialService' });
            throw new InternalServerErrorException('Failed to create credential')
        }
    }
}