import { Controller, ForbiddenException } from '@nestjs/common';
import { ERROR_MESSAGES } from 'src/data/constants';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  createStudentSchema,
  getParentsQuerySchema,
  getStudentsQuerySchema,
  setStudentPasswordSchema,
  updateStudentSchema,
  type CreateStudentDto,
  type GetParentsQueryDto,
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
  async generateCode(@Payload() payload: RpcActorPayload) {
    // Only a gateway-signed ADMIN/TUTOR may mint codes; an unsigned actor resolves to an empty role.
    const { actor } = splitRpcActor(payload ?? {});
    if (actor.role !== 'ADMIN' && actor.role !== 'TUTOR') {
      throw new ForbiddenException(ERROR_MESSAGES.FORBIDDEN_USER_ACTION);
    }
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

  /** Parent picker: PARENT accounts the caller may attach to a student (TUTOR: their own). */
  @MessagePattern('student.findParents')
  async findParents(@Payload() payload: GetParentsQueryDto & RpcActorPayload) {
    const { actor, rest } = splitRpcActor(payload);
    return this.studentService.findParents(
      parseRpcPayload<GetParentsQueryDto>(getParentsQuerySchema, rest),
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

  @MessagePattern('student.setPassword')
  async setPassword(@Payload() payload: { id: string; password: string } & RpcActorPayload) {
    const { actor, rest } = splitRpcActor(payload);
    const body = parseRpcPayload<{ password: string }>(setStudentPasswordSchema, {
      password: rest.password,
    });
    return this.studentService.setPassword(rest.id, body.password, actor);
  }

  @MessagePattern('student.findChildren')
  async findChildren(@Payload() payload: RpcActorPayload) {
    const { actor } = splitRpcActor(payload);
    return this.studentService.findChildren(actor);
  }
}
