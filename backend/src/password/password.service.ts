import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { MasterPasswordDTO } from './dto/password.dto';
import * as argon2 from 'argon2'
@Injectable()
export class PasswordService {
    constructor(
        private readonly prisma: PrismaService
    ){}
    private readonly logger = new Logger(PasswordService.name);

    async verifyMasterPassword(masterPasswordDTO: MasterPasswordDTO) {
        const existingPassword = await this.prisma.masterPassword.findFirst({})
        if(existingPassword?.hash == null) {
            this.logger.error("Password not found in DB")
            throw new NotFoundException("Password not found in DB")
        }

        const isSame = await argon2.verify(existingPassword.hash, masterPasswordDTO.masterPassword)
        if(isSame) {
            return {
                success: true
            }
        }
        return {
            success: false
        }
    }
}
