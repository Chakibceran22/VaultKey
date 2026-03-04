import { Controller, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from 'src/auth/guards/auth.guard';

@Controller('password')
export class PasswordController {
    @UseGuards(AuthGuard)
    @Post('test')
    async testPasswordEndpoint() {
        return { message: "Password endpoint is protected and working!" }
    }
}
