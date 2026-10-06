// Must load env vars before any other import — `AppModule` transitively imports
// `rmq.constants.ts`, which reads `process.env.RABBITMQ_URL` at module top-level
// (evaluated during this static import chain, before `ConfigModule.forRoot()` ever
// runs inside `NestFactory.create()` below). Without this, RmqProducer's ClientProxy
// silently falls back to `amqp://guest:guest@localhost:5672` instead of the real URL.
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { ResponseInterceptor } from '@packages/interceptor/response.interceptor';
import { ErrorInterceptor, LoggerInterceptor } from '@packages/interceptor';
import { HttpExceptionFilter, RpcExceptionFilter } from '@packages/filters';
import { TraceContextInterceptor } from '@packages/interceptor';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { setLogSink } from '@packages/context/log-sink';
import { RmqProducer } from './features/rabbitmq/rmq.producer';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug', 'verbose'],
  });
  app.enableShutdownHooks();

  // Ships every RPC-hop row to third-service's `request_logs` table, fire-and-forget.
  const rmqProducer = app.get(RmqProducer);
  setLogSink((entry) => rmqProducer.emit('log.create', entry));

  // `deferInitialization: true` is required: by default `connectMicroservice()` synchronously
  // calls `registerListeners()` before returning, which binds every @MessagePattern handler to
  // whatever global filters exist *at that moment* (none) — a `useGlobalFilters()` call after
  // that point is silently too late (Nest logs "Cannot apply global exception filters:
  // registration must occur before initialization" and the base `BaseRpcExceptionFilter`
  // fallback keeps handling errors instead). Deferring means listener registration happens
  // inside `startAllMicroservices()` → `listen()`, after our filter is already in place.
  const rmqMicroservice = app.connectMicroservice<MicroserviceOptions>(
    {
      transport: Transport.RMQ,
      options: {
        urls: [process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5672'],
        queue: process.env.USER_QUEUE ?? 'user_queue',
        queueOptions: { durable: true },
        prefetchCount: 10,
      },
    },
    { deferInitialization: true },
  );
  // Global for this microservice only — every @MessagePattern handler gets it for free, no
  // per-controller @UseFilters(RpcExceptionFilter) needed. Kept off the HTTP `app` global
  // filters (RpcExceptionFilter expects an RPC context, not an Express Response).
  rmqMicroservice.useGlobalFilters(new RpcExceptionFilter());
  // Opens the correlationId/traceId/serviceName RequestContext for every @MessagePattern
  // handler — see [[rmq-rpc-plumbing]] memory.
  rmqMicroservice.useGlobalInterceptors(new TraceContextInterceptor());
  await app.startAllMicroservices();
  Logger.log(
    `[USER] RabbitMQ listener bound (queue "${process.env.USER_QUEUE ?? 'user_queue'}")`,
    'Bootstrap',
  );

  app.enableCors({ origin: true, credentials: true });
  app.useGlobalInterceptors(new ResponseInterceptor(app.get(Reflector)));
  app.useGlobalInterceptors(new ErrorInterceptor(), new LoggerInterceptor());
  app.useGlobalFilters(new HttpExceptionFilter());

  const config = new DocumentBuilder()
    .setTitle('User Service API')
    .setDescription('API documentation for the tutoring platform user/identity service')
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Enter JWT access token',
      },
      'access-token',
    )
    .addTag('Users')
    .addTag('Auth')
    .addTag('Students')
    .addTag('Admin')
    .addTag('Health')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api-docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
    },
  });

  const port = process.env.PORT ?? 8888;
  await app.listen(port);
  Logger.log(`[USER] listening on port ${port}`, 'Bootstrap');
}
void bootstrap();
