import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston/dist/winston.constants';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import pRetry from 'p-retry';
import { GlobalExceptionFilter } from './common/filters/GlobalExceptionFilter.filter';
import { PrismaExceptionFilter } from './common/filters/PrismaExceptionFilter.filter';

async function bootstrap(): Promise<void> {
  let app: NestExpressApplication | undefined;

  await pRetry(
    async () => {
      app = await NestFactory.create<NestExpressApplication>(AppModule);
      app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER));
      app.use(helmet());

      app.useGlobalPipes(new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }));
      app.useGlobalFilters(new GlobalExceptionFilter(app.get(WINSTON_MODULE_NEST_PROVIDER)),
    new PrismaExceptionFilter(app.get(WINSTON_MODULE_NEST_PROVIDER)));

      app.enableCors();

      await app.listen(process.env.PORT ?? 3000);
    },
    {
      retries: 3,
      minTimeout: 3000,
      onFailedAttempt: async (error) => {
        console.error(`Attempt ${error.attemptNumber} failed. ${error.retriesLeft} retries left.`);
        if (app) await app.close().catch(() => {});
        app = undefined; // reset for next attempt
      },
    }
  );
}

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});

bootstrap().catch(() => {
  console.error('All retries exhausted. Shutting down.');
  process.exit(1);
});