import { Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston/dist/winston.constants';
import { PrismaService } from 'src/prisma/prisma.service';
import { AuthStatusResponseDTO } from './dtos/AuthStatusResponse.dto';
import { AuthKeyDTO } from './dtos/AuthKeyDTO';
import { JwtService } from '@nestjs/jwt';
@Injectable()
export class AuthService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly jwtService: JwtService,
        @Inject(WINSTON_MODULE_NEST_PROVIDER) private readonly logger: Logger
    ) { }
    async testStatus() {
        try {
            const result = await this.prisma.authKey.findFirst();
            if (!result) {
                this.logger.warn("No auth key found in the database", { context: 'AuthService' });
                return {
                    status: AuthStatusResponseDTO.NEEDS_SIGNUP
                }
            }
            this.logger.log("Auth key found, backend is healthy", { context: 'AuthService' });
            return {
                status: AuthStatusResponseDTO.NEEDS_LOGIN
            }


        } catch (error) {
            console.error("Error in testStatus:", error)
            this.logger.error(`Error in testStatus: ${error.message}`, { context: 'AuthService' });
            return {
                status: AuthStatusResponseDTO.ERROR
            }

        }
    }

    async registerAuthKey(authKeyDTO: AuthKeyDTO) {
        try {
            const data = await this.prisma.authKey.create({
                data: {
                    hash: authKeyDTO.authKey
                }
            })
            this.logger.log("Auth key registered successfully", { context: 'AuthService' });
            return { status: 'success' }

        } catch (error) {
            return {
                status: false
            }
        }

    }

    async verifyAuthKey(authKeyDTO: AuthKeyDTO) {
        try {
            const key = authKeyDTO.authKey;
            const dbKey = await this.prisma.authKey.findFirst();
            if (!dbKey) {
                this.logger.warn("No auth key found in the database during verification", { context: 'AuthService' });
                return false;
            }
            const isValid = key === dbKey.hash;
            this.logger.log(`Auth key verification result: ${isValid}`, { context: 'AuthService' });
            if(isValid) {
                const token = this.jwtService.sign({ sub: 'master-user' }, { expiresIn: '7h' });
                return { valid: true, token };
            }
            return { 
                valid: false,
                token: null
             };
        } catch (error) {
            throw new InternalServerErrorException('Error verifying master password')
        }
    }
}
