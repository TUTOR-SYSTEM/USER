import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminRpcController } from './admin.rpc.controller';
import { AdminService } from './admin.service';
import { AdminRepository } from './admin.repository';

@Module({
  controllers: [AdminController, AdminRpcController],
  providers: [AdminService, AdminRepository],
  exports: [AdminService],
})
export class AdminModule {}
