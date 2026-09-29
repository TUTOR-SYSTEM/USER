import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import type {
  ChangePasswordValues,
  CreateUserDto,
  GetUsersQueryDto,
  UpdateUserDto,
  UserDataFieldDto,
} from '@packages/entities/user';
import { UserService } from './user.service';

/**
 * Message-pattern mirror of `UserController` — reached only by the gateway's `RmqProducer`
 * over `user_queue` (`user.*` patterns). Delegates to the same, unmodified `UserService` the
 * HTTP controller uses; no business logic lives here.
 */
@Controller()
export class UserRpcController {
  constructor(private readonly userService: UserService) {}

  @MessagePattern('user.getUsers')
  getUsers(@Payload() query: GetUsersQueryDto) {
    return this.userService.getUsersService(query);
  }

  @MessagePattern('user.getDetailUser')
  getDetailUser(@Payload() { userId }: { userId: string }) {
    return this.userService.getDetailUserService({ id: userId });
  }

  @MessagePattern('user.getUserByField')
  getUserByField(@Payload() dto: UserDataFieldDto) {
    return this.userService.getUserByField(dto);
  }

  @MessagePattern('user.createUser')
  createUser(@Payload() dto: CreateUserDto) {
    return this.userService.createUserService(dto);
  }

  @MessagePattern('user.updateUser')
  updateUser(
    @Payload() { userId, role, ...data }: { userId: string; role: string } & UpdateUserDto,
  ) {
    return this.userService.updateOwnProfileService({ id: userId, role, data });
  }

  @MessagePattern('user.updateUserByAdmin')
  updateUserByAdmin(@Payload() { id, ...data }: { id: string } & UpdateUserDto) {
    return this.userService.updateUserService({ id, data });
  }

  @MessagePattern('user.updateStatusUser')
  updateStatusUser(@Payload() { id }: { id: string }) {
    return this.userService.updateStatusUserService({ id });
  }

  @MessagePattern('user.deleteUserByAdmin')
  deleteUserByAdmin(@Payload() { id }: { id: string }) {
    return this.userService.deleteUserByAdminService({ id });
  }

  @MessagePattern('user.changePassword')
  changePassword(@Payload() { userId, ...dto }: { userId: string } & ChangePasswordValues) {
    return this.userService.changePasswordService(userId, dto as ChangePasswordValues);
  }
}
