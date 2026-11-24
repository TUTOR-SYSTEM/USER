import { BadRequestException, Controller, Get, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse as SwaggerResponse } from '@nestjs/swagger';
import { AppService } from './app.service';
import { EventPattern, MessagePattern, Payload } from '@nestjs/microservices';
import { RmqProducer } from './features/rabbitmq/rmq.producer';
import { PrismaService } from './database/database.module';

/** Debug RPCs log the shape of what they receive, never the values (it may carry personal data). */
function describePayload(data: unknown): string {
  if (data === null || typeof data !== 'object') return typeof data;
  return `{${Object.keys(data).join(',')}}`;
}

@ApiTags('Health')
@Controller()
export class AppController {
  private readonly logger = new Logger(AppController.name);
  constructor(
    private readonly appService: AppService,
    private readonly rmqProducer: RmqProducer,
    private readonly db: PrismaService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Health check', description: 'Returns a simple health check response' })
  @SwaggerResponse({
    status: 200,
    description: 'Server is running',
    schema: { type: 'string', example: 'Hello World!' },
  })
  getHello(): string {
    return this.appService.getHello();
  }

  @EventPattern('kafka.emit')
  emitRequestFromKafka(@Payload() data: unknown): void {
    this.logger.log(`[EMIT] kafka.ping <- gateway, payload=${describePayload(data)}`);
  }

  @MessagePattern('kafka.ping')
  sendRequestFromKafka(@Payload() data: unknown): void {
    this.logger.log(`[EMIT] kafka.ping <- gateway, payload=${describePayload(data)}`);
  }

  @MessagePattern('kafka.user.error')
  receivedError(@Payload() data: unknown): void {
    this.logger.log(`[SEND] kafka.ping <- gateway, payload=${describePayload(data)}`);
    throw new BadRequestException('data from user failed ...');
  }

  @MessagePattern('kafka.user')
  async receivedMsgError(@Payload() data: unknown) {
    this.logger.log(`[SEND] kafka.ping <- gateway, payload=${describePayload(data)}`);
    return await this.rmqProducer.send<unknown, unknown>('kafka.tutor', data);
  }

  @MessagePattern('kafka.send')
  async handleKafkaSend(@Payload() data: unknown) {
    const startTime = Date.now();
    const requestId = `user-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    this.logger.log(
      `[RECEIVE-START] requestId=${requestId} kafka.send <- gateway, payload=${describePayload(data)}`,
    );

    try {
      const userData = data as {
        email?: string;
        firstName?: string;
        lastName?: string;
        username?: string;
        role?: string;
        timestamp?: string;
      };

      // Log processing start
      this.logger.log(`[PROCESSING] requestId=${requestId} processing user data...`);

      // Process the data received from gateway
      const response = {
        statusCode: 200,
        message: 'User data processed successfully',
        data: {
          userId: 'generated-uuid-' + Date.now(),
          email: userData.email || 'no-email',
          fullName: `${userData.firstName || 'N/A'} ${userData.lastName || 'N/A'}`.trim(),
          username: userData.username || 'no-username',
          role: userData.role || 'STUDENT',
          processedAt: new Date().toISOString(),
          receivedAt: userData.timestamp,
        },
      };

      const processingDuration = Date.now() - startTime;
      this.logger.log(
        `[RESPONSE-READY] requestId=${requestId} kafka.send -> gateway, duration=${processingDuration}ms, response=${JSON.stringify(response)}`,
      );

      return response;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(
        `[RECEIVE-FAILED] requestId=${requestId} kafka.send processing error, duration=${duration}ms, error=${
          error instanceof Error ? error.message : JSON.stringify(error)
        }, stack=${error instanceof Error ? error.stack : ''}`,
      );
      throw error;
    }
  }

  /**
   * Database health. Counts only: it never loads user rows, and it returns no personal data
   * (the old `fetchData` sample of user emails is gone).
   */
  @MessagePattern('health.postgres')
  async checkPostgresHealth(): Promise<unknown> {
    this.logger.log('[HEALTH] Checking PostgreSQL connection');
    try {
      const groups = await this.db.user.groupBy({ by: ['role'], _count: { _all: true } });
      const count = (role: string) => groups.find((g) => g.role === role)?._count._all ?? 0;
      const totalUsers = groups.reduce((sum, g) => sum + g._count._all, 0);

      return {
        status: 'healthy',
        database: 'PostgreSQL',
        connection: 'connected',
        timestamp: new Date().toISOString(),
        message: 'Database connection is healthy',
        stats: {
          totalUsers,
          byRole: {
            admin: count('ADMIN'),
            tutor: count('TUTOR'),
            student: count('STUDENT'),
            parent: count('PARENT'),
          },
        },
      };
    } catch (error) {
      this.logger.error(`[HEALTH] PostgreSQL connection failed: ${error}`);
      return {
        status: 'unhealthy',
        database: 'PostgreSQL',
        connection: 'failed',
        timestamp: new Date().toISOString(),
        message: 'Database connection failed',
      };
    }
  }
}
