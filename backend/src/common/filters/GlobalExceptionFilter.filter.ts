import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Inject } from "@nestjs/common";
import { Request, Response } from "express";
import { WINSTON_MODULE_NEST_PROVIDER } from "nest-winston";
import { Logger } from "winston";



@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
    constructor(
        @Inject(WINSTON_MODULE_NEST_PROVIDER) private readonly logger: Logger
    ) { }

    catch(exception: unknown, host: ArgumentsHost) {
        const ctx = host.switchToHttp();
        const response = ctx.getResponse<Response>();
        const request = ctx.getRequest<Request>();
        this.logger.error(
            `Unhandled exception on [${request.method}] ${request.url}`,
            exception instanceof Error ? exception.stack : String(exception),
            GlobalExceptionFilter.name,
        );


        response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
            statusCode: 500,
            message: 'Internal server error',
            path: request.url,
            method: request.method,
            timestamp: new Date().toISOString(),
        });
    }

}