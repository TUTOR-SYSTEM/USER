import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  createManagedUserSchema,
  listManagedUsersQuerySchema,
  updateManagedStudentSchema,
  updateManagedUserSchema,
  type CreateManagedUserDto,
  type ListManagedUsersQueryDto,
  type UpdateManagedStudentDto,
  type UpdateManagedUserDto,
} from '@packages/entities/admin';
import { parseRpcPayload, splitRpcActor, type RpcActorPayload } from '@packages/helpers';
import { AdminService } from './admin.service';

/**
 * Message-pattern mirror of `AdminController` — reached by the gateway's `RmqProducer` over
 * `user_queue` (`admin.*` patterns). Delegates to the same `AdminService` the HTTP controller uses.
 * The caller comes from `actorId`/`actorRole` the gateway forwards; the service rejects anyone who
 * is not ADMIN.
 */
@Controller()
export class AdminRpcController {
  constructor(private readonly adminService: AdminService) {}

  // ─── Tutors ────────────────────────────────────────────────────────
  @MessagePattern('admin.createTutor')
  async createTutor(@Payload() payload: CreateManagedUserDto & RpcActorPayload) {
    const { actor, rest } = splitRpcActor(payload);
    return this.adminService.createTutor(
      parseRpcPayload<CreateManagedUserDto>(createManagedUserSchema, rest),
      actor,
    );
  }

  @MessagePattern('admin.listTutors')
  async listTutors(@Payload() payload: ListManagedUsersQueryDto & RpcActorPayload) {
    const { actor, rest } = splitRpcActor(payload);
    return this.adminService.listTutors(
      parseRpcPayload<ListManagedUsersQueryDto>(listManagedUsersQuerySchema, rest),
      actor,
    );
  }

  @MessagePattern('admin.getTutor')
  async getTutor(@Payload() payload: { id: string } & RpcActorPayload) {
    const { actor, rest } = splitRpcActor(payload);
    return this.adminService.getTutor(rest.id, actor);
  }

  @MessagePattern('admin.updateTutor')
  async updateTutor(@Payload() payload: { id: string } & RpcActorPayload & UpdateManagedUserDto) {
    const { actor, rest } = splitRpcActor(payload);
    const { id, ...body } = rest;
    return this.adminService.updateTutor(
      id,
      parseRpcPayload<UpdateManagedUserDto>(updateManagedUserSchema, body),
      actor,
    );
  }

  @MessagePattern('admin.deleteTutor')
  async deleteTutor(@Payload() payload: { id: string } & RpcActorPayload) {
    const { actor, rest } = splitRpcActor(payload);
    return this.adminService.deleteTutor(rest.id, actor);
  }

  // ─── Students ──────────────────────────────────────────────────────
  @MessagePattern('admin.createStudent')
  async createStudent(@Payload() payload: CreateManagedUserDto & RpcActorPayload) {
    const { actor, rest } = splitRpcActor(payload);
    return this.adminService.createStudent(
      parseRpcPayload<CreateManagedUserDto>(createManagedUserSchema, rest),
      actor,
    );
  }

  @MessagePattern('admin.listStudents')
  async listStudents(@Payload() payload: ListManagedUsersQueryDto & RpcActorPayload) {
    const { actor, rest } = splitRpcActor(payload);
    return this.adminService.listStudents(
      parseRpcPayload<ListManagedUsersQueryDto>(listManagedUsersQuerySchema, rest),
      actor,
    );
  }

  @MessagePattern('admin.getStudent')
  async getStudent(@Payload() payload: { id: string } & RpcActorPayload) {
    const { actor, rest } = splitRpcActor(payload);
    return this.adminService.getStudent(rest.id, actor);
  }

  @MessagePattern('admin.updateStudent')
  async updateStudent(
    @Payload() payload: { id: string } & RpcActorPayload & UpdateManagedStudentDto,
  ) {
    const { actor, rest } = splitRpcActor(payload);
    const { id, ...body } = rest;
    return this.adminService.updateStudent(
      id,
      parseRpcPayload<UpdateManagedStudentDto>(updateManagedStudentSchema, body),
      actor,
    );
  }

  @MessagePattern('admin.deleteStudent')
  async deleteStudent(@Payload() payload: { id: string } & RpcActorPayload) {
    const { actor, rest } = splitRpcActor(payload);
    return this.adminService.deleteStudent(rest.id, actor);
  }
}
