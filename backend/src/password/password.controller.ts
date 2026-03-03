import { Body, Controller, Inject, Logger, Post } from '@nestjs/common';
import { MasterPasswordDTO } from './dto/password.dto';
import { PasswordService } from './password.service';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';

@Controller('password')
export class PasswordController {
    constructor(
        private readonly passwordService: PasswordService,
        @Inject(WINSTON_MODULE_NEST_PROVIDER) private readonly logger: Logger
    ){}
    @Post('verify')
    async verifyPassword(@Body() masterPasswordDTO: MasterPasswordDTO) {
        this.logger.log("Received request to verify master password")
        return await this.passwordService.verifyMasterPassword(masterPasswordDTO)
    }
}
