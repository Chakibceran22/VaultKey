import { Body, Controller, Logger, Post } from '@nestjs/common';
import { MasterPasswordDTO } from './dto/password.dto';
import { PasswordService } from './password.service';

@Controller('password')
export class PasswordController {
    constructor(
        private readonly passwordService: PasswordService
    ){}
    private readonly logger = new Logger(PasswordController.name);
    @Post('verify')
    async verifyPassword(@Body() masterPasswordDTO: MasterPasswordDTO) {
        this.logger.log("Received request to verify master password")

        return await this.passwordService.verifyMasterPassword(masterPasswordDTO)
    }
}
