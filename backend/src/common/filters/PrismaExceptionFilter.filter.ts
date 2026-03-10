import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Inject, Logger } from "@nestjs/common";
import { Prisma } from "generated/prisma/client";
import { Request, Response } from "express";
import { WINSTON_MODULE_NEST_PROVIDER } from "nest-winston/dist/winston.constants";

@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
    constructor(
        @Inject(WINSTON_MODULE_NEST_PROVIDER) private readonly logger: Logger
    ){}

    catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
        const ctx = host.switchToHttp();
        const response = ctx.getResponse<Response>();
        const request = ctx.getRequest<Request>();

        const { status, message } = this.resolveException(exception);

        response.status(status).json({
            statusCode: status,
            message,
            path: request.url,
            method: request.method,
            timestamp: new Date().toISOString(),
        });
    }

    private resolveException(exception: Prisma.PrismaClientKnownRequestError): { status: number; message: string } {
        switch (exception.code) {
            case 'P2002':
                this.logger.error(`Unique constraint violation: ${(exception.meta?.target as string[])?.join(', ')}`, { context: 'PrismaExceptionFilter' });
                return {
                    status: HttpStatus.CONFLICT,
                    message: `Already exists: ${(exception.meta?.target as string[])?.join(', ')}`,
                };
            case 'P2025':
                this.logger.error(`Record not found: ${exception.meta?.cause}`, { context: 'PrismaExceptionFilter' });
                return {
                    status: HttpStatus.NOT_FOUND,
                    message: 'Record not found',
                };
            case 'P2003':
                this.logger.error(`Foreign key constraint violation: ${exception.meta?.cause}`, { context: 'PrismaExceptionFilter' });
                return {
                    status: HttpStatus.BAD_REQUEST,
                    message: 'Invalid relation',
                };
            case 'P2014':
                this.logger.error(`Relation violation: ${exception.meta?.cause}`, { context: 'PrismaExceptionFilter' });
                return {
                    status: HttpStatus.BAD_REQUEST,
                    message: 'Relation violation',
                };
            default:
                this.logger.error(`Unhandled Prisma error: ${exception.message}`, { context: 'PrismaExceptionFilter' });
                return {
                    status: HttpStatus.INTERNAL_SERVER_ERROR,
                    message: 'Database error',
                };
        }
    }
}