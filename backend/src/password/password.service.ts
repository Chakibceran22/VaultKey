import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { MasterPasswordDTO } from './dto/password.dto';
import * as argon2 from 'argon2'
@Injectable()
export class PasswordService {
    constructor(
        private readonly prisma: PrismaService
    ){}

    async verifyMasterPassword(masterPasswordDTO: MasterPasswordDTO) {
        const existingPassword = await this.prisma.masterPassword.findFirst({})
        if(existingPassword?.hash == null) {
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
