import { Body, Controller, Post } from '@nestjs/common';
import { MasterPasswordDTO } from './dto/password.dto';
import { PasswordService } from './password.service';

@Controller('password')
export class PasswordController {
    constructor(
        private readonly passwordServic: PasswordService
    ){}
    @Post('verify')
    async verifyPassword(@Body() masterPasswordDTO: MasterPasswordDTO) {
        return await this.passwordServic.verifyMasterPassword(masterPasswordDTO)
    }
}
