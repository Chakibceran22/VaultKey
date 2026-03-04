import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CredentialsDTO } from './dtos/Credentials.dto';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston/dist/winston.constants';
@Injectable()
export class CredentialService {
    constructor(
        private readonly prisma: PrismaService,
        @Inject(WINSTON_MODULE_NEST_PROVIDER) private readonly logger: Logger
    ){}
    async createCredential(CredentialDTO: CredentialsDTO) {
        try {
            
        } catch (error) {
            console.log("error")
            this.logger.error(`Error in createCredential: ${error.message}`, { context: 'CredentialService' });
        }
    }
}
