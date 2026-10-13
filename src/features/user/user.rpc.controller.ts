import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import type {
  ChangePasswordValues,
  CreateUserDto,
  GetUsersQueryDto,
  UpdateUserDto,
  UserDataFieldDto,
} from '@packages/entities/user';
import { UserActor, UserService } from './user.service';

/** Caller identity the gateway forwards with every admin/tutor-scoped call. */
interface RpcActorPayload {
  actorId?: string;
  actorRole?: string;
}

/**
 * Splits the caller identity off the payload so it never reaches the data written to the DB.
 * A missing `actorId`/`actorRole` becomes an empty identity, which the service rejects (403).
 */
function splitActor<T extends RpcActorPayload>(payload: T) {
  const rest: Partial<T> = { ...payload };
  delete rest.actorId;
  delete rest.actorRole;
  const actor: UserActor = { id: payload.actorId ?? '', role: payload.actorRole ?? '' };
  return { actor, rest: rest as Omit<T, keyof RpcActorPayload> };
}

/**
 * Message-pattern mirror of `UserController` — reached only by the gateway's `RmqProducer`
 * over `user_queue` (`user.*` patterns). Delegates to the same `UserService` the HTTP controller
 * uses; no business logic lives here. Authorization is enforced in the service against the
 * forwarded actor, not by trusting the target id in the payload.
 */
@Controller()
export class UserRpcController {
  constructor(private readonly userService: UserService) {}

  @MessagePattern('user.getUsers')
  getUsers(@Payload() query: GetUsersQueryDto) {
    return this.userService.getUsersService(query);
  }

  @MessagePattern('user.getDetailUser')
  getDetailUser(@Payload() payload: { userId: string; expectedRole?: string } & RpcActorPayload) {
    const { actor, rest } = splitActor(payload);
    return this.userService.getDetailUserService({
      id: rest.userId,
      actor,
      expectedRole: rest.expectedRole,
    });
  }

  @MessagePattern('user.getUserByField')
  getUserByField(@Payload() dto: UserDataFieldDto) {
    return this.userService.findUsersByFieldPublic(dto);
  }

  @MessagePattern('user.createUser')
  createUser(@Payload() dto: CreateUserDto) {
    return this.userService.createUserService(dto);
  }

  /** Self-update or admin edit of a student (`PUT /students/:id`). `role` is ignored (see service). */
  @MessagePattern('user.updateUser')
  updateUser(
    @Payload() payload: { userId: string; role?: string } & RpcActorPayload & UpdateUserDto,
  ) {
    const { actor, rest } = splitActor(payload);
    const { userId, ...data } = rest;
    // The gateway also forwards the caller's `role` on self-updates; it is not a writable field.
    delete data.role;
    return this.userService.updateOwnProfileService({ id: userId, actor, data });
  }

  @MessagePattern('user.updateUserByAdmin')
  updateUserByAdmin(
    @Payload() payload: { id: string; expectedRole?: string } & RpcActorPayload & UpdateUserDto,
  ) {
    const { actor, rest } = splitActor(payload);
    const { id, expectedRole, ...data } = rest;
    return this.userService.updateUserService({ id, data, actor, expectedRole });
  }

  @MessagePattern('user.updateStatusUser')
  updateStatusUser(@Payload() payload: { id: string } & RpcActorPayload) {
    const { actor, rest } = splitActor(payload);
    return this.userService.updateStatusUserService({ id: rest.id, actor });
  }

  @MessagePattern('user.deleteUserByAdmin')
  deleteUserByAdmin(@Payload() payload: { id: string; expectedRole?: string } & RpcActorPayload) {
    const { actor, rest } = splitActor(payload);
    return this.userService.deleteUserByAdminService({
      id: rest.id,
      actor,
      expectedRole: rest.expectedRole,
    });
  }

  @MessagePattern('user.changePassword')
  changePassword(@Payload() { userId, ...dto }: { userId: string } & ChangePasswordValues) {
    return this.userService.changePasswordService(userId, dto);
  }
}
