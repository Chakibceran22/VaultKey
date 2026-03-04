import { Body, Controller, UseGuards } from '@nestjs/common';
import { AuthGuard } from 'src/auth/guards/auth.guard';
import { Post } from '@nestjs/common';
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
}
