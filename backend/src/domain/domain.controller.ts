import { Body, Controller, Delete, Param, UseGuards } from '@nestjs/common';
import { AuthGuard } from 'src/auth/guards/auth.guard';
import { Post,Get } from '@nestjs/common';
import { DomainService } from './domain.service';
import { DomainDTO } from './dtos/DomainDTO';
@Controller('domain')
export class DomainController {
    constructor(
        private readonly domainService: DomainService
        
    ){}
    @UseGuards(AuthGuard)
    @Post('register')
    async registerDomain(@Body() domainDTO: DomainDTO) {
        return await this.domainService.registerDomain(domainDTO);
    }
    @UseGuards(AuthGuard)
    @Get('fetch')
    async fetchDomains() {
        return await this.domainService.fetchDomains();
    }

    @UseGuards(AuthGuard)
    @Delete('delete/:domainId')
    async deleteDomain(@Param('domainId') domainId: number) {
        return await this.domainService.deleteDomain(domainId);
    }

}
