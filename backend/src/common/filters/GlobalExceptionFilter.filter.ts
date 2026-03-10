import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Inject } from "@nestjs/common";
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

        const { status, message } = this.resolveException(exception);

        this.logger.error(
            `[${request.method}] ${request.url} → ${status}: ${message}`,
            exception instanceof Error ? exception.stack : String(exception),
            GlobalExceptionFilter.name,
        );

        response.status(status).json({
            statusCode: status,
            message,
            path: request.url,
            method: request.method,
            timestamp: new Date().toISOString(),
        });
    }

    private resolveException(exception: unknown): { status: number; message: string } {
        if (exception instanceof HttpException) {
            const res = exception.getResponse();
            const message = typeof res === 'string' 
                ? res 
                : (res as any).message ?? exception.message;
            return { status: exception.getStatus(), message };
        }

        return {
            status: HttpStatus.INTERNAL_SERVER_ERROR,
            message: 'Internal server error',
        };
    }
}