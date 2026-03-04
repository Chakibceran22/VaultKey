import { Inject, Injectable, Logger } from '@nestjs/common';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston/dist/winston.constants';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class AuthService {
    constructor(
        private readonly prisma: PrismaService,
        @Inject(WINSTON_MODULE_NEST_PROVIDER) private readonly logger: Logger  
    ) {}
    async testStatus() {
        try {
            const result = await this.prisma.authKey.findFirst();
            if(!result) {
                this.logger.warn("No auth key found in the database", { context: 'AuthService' });
                return {
                    status: 'needs_signup'
                }
            }
            this.logger.log("Auth key found, backend is healthy", { context: 'AuthService' });
            return {
                status: 'need_login'
            }

            
        } catch (error) {
            console.error("Error in testStatus:", error)
            this.logger.error(`Error in testStatus: ${error.message}`, { context: 'AuthService' });
            
        }
    }
}
