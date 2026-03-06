import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from 'src/auth/guards/auth.guard';
import { CreateCredentialsDTO } from './dtos/Credentials.dto';
import { CredentialService } from './credential.service';
import { DomainIDDTO } from './dtos/domainid.dto';

@Controller('credential')
export class CredentialController {
    constructor(
        private readonly credentialService: CredentialService
    ){}
    @UseGuards(AuthGuard)
    @Post('test')
    async testCredentialEndpoint() {
        return { message: "Credential endpoint is protected and working!" }
    }

    @UseGuards(AuthGuard)
    @Post('create')
    async createCredential(@Body() createCredentialDTO: CreateCredentialsDTO) {
        return await this.credentialService.createCredential(createCredentialDTO);
    }

    @UseGuards(AuthGuard)
    @Get(':domainId')
    async fetchCredentials(@Param('domainId', ParseIntPipe) domainId: number) {
        return await this.credentialService.fetchCredentials(domainId);
    }
}
