import { Module } from '@nestjs/common';
import { StudentController } from './student.controller';
import { StudentRpcController } from './student.rpc.controller';
import { StudentRepository } from './student.repository';
import { StudentService } from './student.service';

@Module({
  controllers: [StudentController, StudentRpcController],
  providers: [StudentService, StudentRepository],
  exports: [StudentService],
})
export class StudentModule {}
