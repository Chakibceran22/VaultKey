import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from 'src/auth/guards/auth.guard';
import { CreateCredentialsDTO } from './dtos/Credentials.dto';
import { CredentialService } from './credential.service';

@Controller('password')
export class CredentialController {
    constructor(
        private readonly credentialService: CredentialService
    ){}
    @UseGuards(AuthGuard)
    @Post('test')
    async testPasswordEndpoint() {
        return { message: "Password endpoint is protected and working!" }
    }

    @UseGuards(AuthGuard)
    @Post('generate')
    async createCredential(@Body() createCredentialDTO: CreateCredentialsDTO) {
        return await this.credentialService.createCredential(createCredentialDTO);
    }
}
