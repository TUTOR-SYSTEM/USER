import { Module } from '@nestjs/common';
import { JwtAuthGuard, RolesGuard } from '@packages/guards';
import { UserController } from './user.controller';
import { UserRpcController } from './user.rpc.controller';
import { UserRepository } from './user.repository';
import { UserService } from './user.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

@Module({
  imports: [],
  controllers: [UserController, UserRpcController],
  providers: [UserService, UserRepository, JwtAuthGuard, RolesGuard, JwtService, ConfigService],
  exports: [UserService],
})
export class UserModule {}
