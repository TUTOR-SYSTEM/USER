import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './features/auth/auth.module';
import { DatabaseModule } from './database/database.module';
import { UserModule } from './features/user/user.module';
import { AdminModule } from './features/admin/admin.module';
import { StudentModule } from './features/student/student.module';
import { JwtAuthGuard, LanguageGuard } from '@packages/guards';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { RmqModule } from './features/rabbitmq/rmq.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    RmqModule,
    DatabaseModule,
    UserModule,
    AdminModule,
    AuthModule,
    StudentModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: '1h' },
    }),
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: LanguageGuard,
    },
  ],
})
export class AppModule {}
