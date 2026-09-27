import { BadRequestException, Controller, Get, Inject, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse as SwaggerResponse } from '@nestjs/swagger';
import { AppService } from './app.service';
import { EventPattern, MessagePattern, Payload } from '@nestjs/microservices';
import { RmqProducer } from './features/rabbitmq/rmq.producer';
import { DRIZZLE } from './database/database.module';

@ApiTags('Health')
@Controller()
export class AppController {
  private readonly logger = new Logger(AppController.name);
  constructor(
    private readonly appService: AppService,
    private readonly rmqProducer: RmqProducer,
    @Inject(DRIZZLE) private readonly db: any,
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
    this.logger.log(`[EMIT] kafka.ping <- gateway, payload=${JSON.stringify(data)}`);
  }

  @MessagePattern('kafka.ping')
  sendRequestFromKafka(@Payload() data: unknown): void {
    this.logger.log(`[EMIT] kafka.ping <- gateway, payload=${JSON.stringify(data)}`);
  }

  @MessagePattern('kafka.user.error')
  receivedError(@Payload() data: unknown): void {
    this.logger.log(`[SEND] kafka.ping <- gateway, payload=${JSON.stringify(data)}`);
    throw new BadRequestException('data from user failed ...');
  }

  @MessagePattern('kafka.user')
  async receivedMsgError(@Payload() data: unknown) {
    this.logger.log(`[SEND] kafka.ping <- gateway, payload=${JSON.stringify(data)}`);
    return await this.rmqProducer.send<unknown, unknown>('kafka.tutor', data);
  }

  @MessagePattern('kafka.send')
  async handleKafkaSend(@Payload() data: unknown) {
    const startTime = Date.now();
    const requestId = `user-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    this.logger.log(
      `[RECEIVE-START] requestId=${requestId} kafka.send <- gateway, payload=${JSON.stringify(data)}`,
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

  @MessagePattern('health.postgres')
  async checkPostgresHealth(@Payload() payload?: { fetchData?: boolean }): Promise<unknown> {
    this.logger.log('[HEALTH] Checking PostgreSQL connection');
    try {
      const shouldFetchData = payload?.fetchData ?? false;

      // Get total user count
      const allUsers = await this.db.query.users.findMany();
      const totalUsers = allUsers.length;

      // Get users by role
      const adminUsers = allUsers.filter((u) => u.role === 'ADMIN');
      const tutorUsers = allUsers.filter((u) => u.role === 'TUTOR');
      const studentUsers = allUsers.filter((u) => u.role === 'STUDENT');
      const parentUsers = allUsers.filter((u) => u.role === 'PARENT');

      const stats = {
        status: 'healthy',
        database: 'PostgreSQL',
        connection: 'connected',
        timestamp: new Date().toISOString(),
        message: 'Database connection is healthy',
        stats: {
          totalUsers,
          byRole: {
            admin: adminUsers.length,
            tutor: tutorUsers.length,
            student: studentUsers.length,
            parent: parentUsers.length,
          },
        },
      };

      if (shouldFetchData && totalUsers > 0) {
        // Return sample users (limit to 5)
        stats['sampleUsers'] = allUsers.slice(0, 5).map((u) => ({
          id: u.id,
          email: u.email,
          username: u.username,
          firstName: u.firstName,
          lastName: u.lastName,
          role: u.role,
          isActive: u.isActive,
          createdAt: u.createdAt,
        }));
      }

      this.logger.log('[HEALTH] PostgreSQL connection OK, fetched data');
      return stats;
    } catch (error) {
      this.logger.error(`[HEALTH] PostgreSQL connection failed: ${error}`);
      return {
        status: 'unhealthy',
        database: 'PostgreSQL',
        connection: 'failed',
        timestamp: new Date().toISOString(),
        message: error instanceof Error ? error.message : 'Database connection failed',
      };
    }
  }
}
