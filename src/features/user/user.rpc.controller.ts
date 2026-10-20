import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  changePasswordSchema,
  createUserSchema,
  dataFieldSchema,
  getUsersQuerySchema,
  updateUserSchema,
  updateUserStatusSchema,
  type ChangePasswordValues,
  type CreateUserDto,
  type GetUsersQueryDto,
  type UpdateUserDto,
  type UserDataFieldDto,
} from '@packages/entities/user';
import { parseRpcPayload, RpcActorPayload, splitRpcActor } from '@packages/helpers';
import { UserService } from './user.service';

/**
 * Message-pattern mirror of `UserController` — reached only by the gateway's `RmqProducer`
 * over `user_queue` (`user.*` patterns). Delegates to the same `UserService` the HTTP controller
 * uses; no business logic lives here. Every payload is validated with the HTTP schema, and
 * authorization is enforced in the service against the forwarded actor, not by trusting the
 * target id in the payload.
 */
@Controller()
export class UserRpcController {
  constructor(private readonly userService: UserService) {}

  @MessagePattern('user.getUsers')
  async getUsers(@Payload() payload: GetUsersQueryDto & RpcActorPayload) {
    const { actor, rest } = splitRpcActor(payload);
    return this.userService.getUsersService(
      parseRpcPayload<GetUsersQueryDto>(getUsersQuerySchema, rest),
      actor,
    );
  }

  @MessagePattern('user.getDetailUser')
  async getDetailUser(
    @Payload() payload: { userId: string; expectedRole?: string } & RpcActorPayload,
  ) {
    const { actor, rest } = splitRpcActor(payload);
    return this.userService.getDetailUserService({
      id: rest.userId,
      actor,
      expectedRole: rest.expectedRole,
    });
  }

  @MessagePattern('user.getUserByField')
  async getUserByField(@Payload() payload: UserDataFieldDto & RpcActorPayload) {
    const { actor, rest } = splitRpcActor(payload);
    return this.userService.findUsersByFieldPublic(
      parseRpcPayload<UserDataFieldDto>(dataFieldSchema, rest),
      actor,
    );
  }

  @MessagePattern('user.createUser')
  async createUser(@Payload() payload: CreateUserDto & RpcActorPayload) {
    const { actor, rest } = splitRpcActor(payload);
    return this.userService.createUserByActorService(
      parseRpcPayload<CreateUserDto>(createUserSchema, rest),
      actor,
    );
  }

  /** Self-update of the caller's profile. `role` is ignored: it is not a writable field here. */
  @MessagePattern('user.updateUser')
  async updateUser(
    @Payload() payload: { userId: string; role?: string } & RpcActorPayload & UpdateUserDto,
  ) {
    const { actor, rest } = splitRpcActor(payload);
    const { userId, ...body } = rest;
    delete body.role;
    return this.userService.updateOwnProfileService({
      id: userId,
      actor,
      data: parseRpcPayload<UpdateUserDto>(updateUserSchema, body),
    });
  }

  @MessagePattern('user.updateUserByAdmin')
  async updateUserByAdmin(
    @Payload() payload: { id: string; expectedRole?: string } & RpcActorPayload & UpdateUserDto,
  ) {
    const { actor, rest } = splitRpcActor(payload);
    const { id, expectedRole, ...body } = rest;
    return this.userService.updateUserService({
      id,
      data: parseRpcPayload<UpdateUserDto>(updateUserSchema, body),
      actor,
      expectedRole,
    });
  }

  /** Explicit target state (`isActive`), idempotent — not a toggle. */
  @MessagePattern('user.updateStatusUser')
  async updateStatusUser(@Payload() payload: { id: string; isActive: boolean } & RpcActorPayload) {
    const { actor, rest } = splitRpcActor(payload);
    const { isActive } = parseRpcPayload<{ isActive: boolean }>(updateUserStatusSchema, {
      isActive: rest.isActive,
    });
    return this.userService.updateStatusUserService({ id: rest.id, isActive, actor });
  }

  @MessagePattern('user.deleteUserByAdmin')
  async deleteUserByAdmin(
    @Payload() payload: { id: string; expectedRole?: string } & RpcActorPayload,
  ) {
    const { actor, rest } = splitRpcActor(payload);
    return this.userService.deleteUserByAdminService({
      id: rest.id,
      actor,
      expectedRole: rest.expectedRole,
    });
  }

  @MessagePattern('user.changePassword')
  async changePassword(@Payload() { userId, ...dto }: { userId: string } & ChangePasswordValues) {
    return this.userService.changePasswordService(
      userId,
      parseRpcPayload<ChangePasswordValues>(changePasswordSchema, dto),
    );
  }
}
