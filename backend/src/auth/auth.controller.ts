import { Body, Controller, Get, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthKeyDTO } from './dtos/AuthKeyDTO';

@Controller('auth')
export class AuthController {
    constructor(
        private readonly authService: AuthService
    ){}
    @Get('status')
    async testStatus() {
        return await  this.authService.testStatus();
    }

    @Post('register')
    async registerAuthKey(@Body() authKeyDTO: AuthKeyDTO) {
        return await this.authService.registerAuthKey(authKeyDTO);
    }

    @Post('verify')
    async verifyMasterPassword(@Body() masterPassword: AuthKeyDTO) {
        return await this.authService.verifyAuthKey(masterPassword);
    }
}
