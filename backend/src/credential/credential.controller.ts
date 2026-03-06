import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, UseGuards } from '@nestjs/common';
import { AuthGuard } from 'src/auth/guards/auth.guard';
import { CreateCredentialsDTO } from './dtos/Credentials.dto';
import { CredentialService } from './credential.service';
import { DomainIDDTO } from './dtos/domainid.dto';
import { UpdateCredentialDTO } from './dtos/UpdateCredential.dto';

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

    @UseGuards(AuthGuard)
    @Delete('delete/:credentialId')
    async deleteCredential(@Param('credentialId', ParseIntPipe) credentialId: number) {
        return await this.credentialService.deleteCredential(credentialId);
    }

    @UseGuards(AuthGuard)
    @Put('update/:credentialId')
    async updateCredential(
        @Param('credentialId', ParseIntPipe) credentialId: number,
        @Body() updateCredentialDTO: UpdateCredentialDTO 
    ) {
        return await this.credentialService.updateCredential(credentialId, updateCredentialDTO);
    }
}
