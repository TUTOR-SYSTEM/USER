import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  createStudentSchema,
  getStudentsQuerySchema,
  updateStudentSchema,
  type CreateStudentDto,
  type GetStudentsQueryDto,
  type UpdateStudentDto,
} from '@packages/entities/student';
import { parseRpcPayload, splitRpcActor, type RpcActorPayload } from '@packages/helpers';
import { StudentService } from './student.service';

/**
 * Message-pattern mirror of `StudentController` — reached by the gateway's `RmqProducer` over
 * `user_queue` (`student.*` patterns). Delegates to the same `StudentService`. ADMIN and TUTOR may
 * call these; a TUTOR is limited to their own students inside the service.
 */
@Controller()
export class StudentRpcController {
  constructor(private readonly studentService: StudentService) {}

  @MessagePattern('student.generateCode')
  async generateCode() {
    return this.studentService.generateStudentCodeService();
  }

  @MessagePattern('student.create')
  async create(@Payload() payload: CreateStudentDto & RpcActorPayload) {
    const { actor, rest } = splitRpcActor(payload);
    return this.studentService.create(
      parseRpcPayload<CreateStudentDto>(createStudentSchema, rest),
      actor,
    );
  }

  @MessagePattern('student.findAll')
  async findAll(@Payload() payload: GetStudentsQueryDto & RpcActorPayload) {
    const { actor, rest } = splitRpcActor(payload);
    return this.studentService.findAll(
      parseRpcPayload<GetStudentsQueryDto>(getStudentsQuerySchema, rest),
      actor,
    );
  }

  @MessagePattern('student.findById')
  async findById(@Payload() payload: { id: string } & RpcActorPayload) {
    const { actor, rest } = splitRpcActor(payload);
    return this.studentService.findById(rest.id, actor);
  }

  @MessagePattern('student.update')
  async update(@Payload() payload: { id: string } & RpcActorPayload & UpdateStudentDto) {
    const { actor, rest } = splitRpcActor(payload);
    const { id, ...body } = rest;
    return this.studentService.update(
      id,
      parseRpcPayload<UpdateStudentDto>(updateStudentSchema, body),
      actor,
    );
  }

  @MessagePattern('student.delete')
  async delete(@Payload() payload: { id: string } & RpcActorPayload) {
    const { actor, rest } = splitRpcActor(payload);
    return this.studentService.delete(rest.id, actor);
  }
}
