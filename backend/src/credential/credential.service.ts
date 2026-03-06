import { ConflictException, Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateCredentialsDTO } from './dtos/Credentials.dto';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston/dist/winston.constants';
import { Prisma } from 'generated/prisma/client'  // ✅ server client, not browser
import { DomainIDDTO } from './dtos/domainid.dto';
import { UpdateCredentialDTO } from './dtos/UpdateCredential.dto';

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


    async fetchCredentials(domainId: number) {
        try {
            
            const credentials = await this.prisma.credential.findMany({
                where: { domainId },
                select: { id: true, username: true, email: true, password: true }
            })
            return { credentials }

        } catch (error) {
            this.logger.error(`Error in fetchCredentials: ${error.message}`, { context: 'CredentialService' });
            throw new InternalServerErrorException('Failed to fetch credentials')
        }
    }

    async deleteCredential(credentialId: number) {
        try {
            const deleted = await this.prisma.credential.delete({
                where: { id: credentialId }
            })
            return { success: !!deleted }
        } catch (error) {
            this.logger.error(`Error in deleteCredential: ${error.message}`, { context: 'CredentialService' });
            throw new InternalServerErrorException('Failed to delete credential')
        }
    }


    async updateCredential(credentialId: number, updateCredentialDTO: UpdateCredentialDTO) {
        try {
            const {username, email, password} = updateCredentialDTO
            const result = await this.prisma.credential.update({
                where: { id: credentialId },
                data: {
                    ...(username !== undefined && { username }),
                    ...(email !== undefined && { email }),
                    ...(password !== undefined && { password })
                }
            })
            return { success: !!result }
            
        } catch (error) {
            this.logger.error(`Error in updateCredential: ${error.message}`, { context: 'CredentialService' });
            throw new InternalServerErrorException('Failed to update credential')
        }
    }
}