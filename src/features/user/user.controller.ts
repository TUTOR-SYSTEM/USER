import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBody,
  ApiQuery,
  ApiParam,
  ApiResponse as SwaggerResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { StatusCodes } from 'http-status-codes';
import { ZodValidationPipe } from '@packages/pipes';
import { CurrentUser, Roles } from '@packages/decorators';
import { RolesGuard } from '@packages/guards';
import {
  changePasswordSchema,
  getUsersQuerySchema,
  type ChangePasswordValues,
  type CreateUserDto,
  type CreateUserResponseDto,
  createUserSchema,
  dataFieldSchema,
  type GetUsersQueryDto,
  type UpdateUserDto,
  updateUserSchema,
  updateUserStatusSchema,
  type UpdateUserStatusDto,
  type UserDataFieldDto,
} from '@packages/entities/user';
import { actorFrom, UserService } from './user.service';
import { USER_SWAGGER_MESSAGES } from 'src/data/swaggers/messages';
import { USER_SWAGGERS_DATA } from 'src/data/swaggers/data/user.swagger';

type GetUsersResponse = Awaited<ReturnType<UserService['getUsersService']>>;

@ApiTags('Users')
@ApiBearerAuth('access-token')
@Controller('user')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @Get('getUsers')
  @HttpCode(StatusCodes.OK)
  @ApiOperation({
    summary: USER_SWAGGER_MESSAGES.GET_USERS_SUCCESSFULLY,
    description: USER_SWAGGER_MESSAGES.GET_USERS_SUCCESSFULLY,
  })
  @ApiQuery(USER_SWAGGERS_DATA.GET_USERS_QUERY[0])
  @ApiQuery(USER_SWAGGERS_DATA.GET_USERS_QUERY[1])
  @ApiQuery(USER_SWAGGERS_DATA.GET_USERS_QUERY[2])
  @ApiQuery(USER_SWAGGERS_DATA.GET_USERS_QUERY[3])
  @ApiQuery(USER_SWAGGERS_DATA.GET_USERS_QUERY[4])
  @ApiQuery(USER_SWAGGERS_DATA.GET_USERS_QUERY[5])
  @SwaggerResponse({
    status: StatusCodes.OK,
    description: USER_SWAGGER_MESSAGES.GET_USERS_SUCCESSFULLY,
  })
  async getUsers(
    @CurrentUser() user: Record<string, string>,
    @Query(new ZodValidationPipe<GetUsersQueryDto>(getUsersQuerySchema))
    query: GetUsersQueryDto,
  ): Promise<GetUsersResponse> {
    return await this.userService.getUsersService(query, actorFrom(user));
  }

  @Get('getDetailUser')
  @HttpCode(StatusCodes.OK)
  @ApiOperation({
    summary: USER_SWAGGER_MESSAGES.GET_USER_SUCCESSFULLY,
    description: USER_SWAGGER_MESSAGES.GET_USER_SUCCESSFULLY,
  })
  @SwaggerResponse({
    status: StatusCodes.OK,
    description: USER_SWAGGER_MESSAGES.GET_USER_SUCCESSFULLY,
  })
  async getDetailUserController(@CurrentUser() user: Record<string, string>) {
    return await this.userService.getDetailUserService({ id: user.id, actor: actorFrom(user) });
  }

  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @Get('getUserByField')
  @HttpCode(StatusCodes.OK)
  @ApiOperation({
    summary: USER_SWAGGER_MESSAGES.GET_USER_BY_FIELD_SUCCESSFULLY,
    description: USER_SWAGGER_MESSAGES.GET_USER_BY_FIELD_SUCCESSFULLY,
  })
  @ApiQuery(USER_SWAGGERS_DATA.GET_USER_BY_FIELD_QUERY[0])
  @ApiQuery(USER_SWAGGERS_DATA.GET_USER_BY_FIELD_QUERY[1])
  @SwaggerResponse({
    status: StatusCodes.OK,
    description: USER_SWAGGER_MESSAGES.GET_USER_BY_FIELD_SUCCESSFULLY,
  })
  async getUserByField(
    @CurrentUser() user: Record<string, string>,
    @Query(new ZodValidationPipe(dataFieldSchema))
    dataFieldDto: UserDataFieldDto,
  ): Promise<unknown> {
    return await this.userService.findUsersByFieldPublic(dataFieldDto, actorFrom(user));
  }

  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @Post('createUser')
  @HttpCode(StatusCodes.CREATED)
  @ApiOperation({
    summary: USER_SWAGGER_MESSAGES.CREATE_USER_SUCCESSFULLY,
    description: USER_SWAGGER_MESSAGES.CREATE_USER_SUCCESSFULLY,
  })
  @ApiBody({ schema: USER_SWAGGERS_DATA.CREATE_USER_SCHEMA })
  @SwaggerResponse({
    status: StatusCodes.CREATED,
    description: USER_SWAGGER_MESSAGES.CREATE_USER_SUCCESSFULLY,
  })
  async createUser(
    @Body(new ZodValidationPipe(createUserSchema))
    createUserDto: CreateUserDto,
  ): Promise<CreateUserResponseDto> {
    return this.userService.createUserService(createUserDto);
  }

  @Put('updateUser')
  @HttpCode(StatusCodes.OK)
  @ApiOperation({
    summary: USER_SWAGGER_MESSAGES.UPDATE_USER_SUCCESSFULLY,
    description: USER_SWAGGER_MESSAGES.UPDATE_USER_SUCCESSFULLY,
  })
  @ApiBody({ schema: USER_SWAGGERS_DATA.UPDATE_USER_SCHEMA })
  @SwaggerResponse({
    status: StatusCodes.OK,
    description: USER_SWAGGER_MESSAGES.UPDATE_USER_SUCCESSFULLY,
  })
  async updateUserController(
    @CurrentUser() user: Record<string, string>,
    @Body(new ZodValidationPipe<UpdateUserDto>(updateUserSchema))
    updateUserDto: UpdateUserDto,
  ) {
    return await this.userService.updateOwnProfileService({
      id: user.id,
      actor: actorFrom(user),
      data: updateUserDto,
    });
  }

  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @Put('updateUserByAdmin/:id')
  @HttpCode(StatusCodes.OK)
  @ApiOperation({
    summary: USER_SWAGGER_MESSAGES.UPDATE_USER_SUCCESSFULLY,
    description: USER_SWAGGER_MESSAGES.UPDATE_USER_SUCCESSFULLY,
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid', description: 'User ID' })
  @ApiBody({ schema: USER_SWAGGERS_DATA.UPDATE_USER_SCHEMA })
  @SwaggerResponse({
    status: StatusCodes.OK,
    description: USER_SWAGGER_MESSAGES.UPDATE_USER_SUCCESSFULLY,
  })
  async updateUserByAdminController(
    @CurrentUser() user: Record<string, string>,
    @Param('id') id: string,
    @Body(new ZodValidationPipe<UpdateUserDto>(updateUserSchema))
    updateUserDto: UpdateUserDto,
  ) {
    return await this.userService.updateUserService({
      id: id,
      data: updateUserDto,
      actor: actorFrom(user),
    });
  }

  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @Put('updateStatusUser/:id')
  @HttpCode(StatusCodes.OK)
  @ApiOperation({
    summary: USER_SWAGGER_MESSAGES.UPDATE_USER_STATUS_SUCCESSFULLY,
    description: USER_SWAGGER_MESSAGES.UPDATE_USER_STATUS_SUCCESSFULLY,
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid', description: 'User ID' })
  @SwaggerResponse({
    status: StatusCodes.OK,
    description: USER_SWAGGER_MESSAGES.UPDATE_USER_STATUS_SUCCESSFULLY,
  })
  async updateStatusUserController(
    @CurrentUser() user: Record<string, string>,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateUserStatusSchema))
    body: UpdateUserStatusDto,
  ) {
    return await this.userService.updateStatusUserService({
      id,
      isActive: body.isActive,
      actor: actorFrom(user),
    });
  }

  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  @Delete('deleteUserByAdmin/:id')
  @HttpCode(StatusCodes.OK)
  @ApiOperation({
    summary: USER_SWAGGER_MESSAGES.DELETE_USER_SUCCESSFULLY,
    description: USER_SWAGGER_MESSAGES.DELETE_USER_SUCCESSFULLY,
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid', description: 'User ID' })
  @SwaggerResponse({
    status: StatusCodes.OK,
    description: USER_SWAGGER_MESSAGES.DELETE_USER_SUCCESSFULLY,
  })
  async deleteUserByAdminController(
    @CurrentUser() user: Record<string, string>,
    @Param('id') id: string,
  ) {
    return await this.userService.deleteUserByAdminService({ id: id, actor: actorFrom(user) });
  }

  @Post('changePassword')
  @HttpCode(StatusCodes.OK)
  @ApiOperation({
    summary: USER_SWAGGER_MESSAGES.CHANGE_PASSWORD_SUCCESSFULLY,
    description: USER_SWAGGER_MESSAGES.CHANGE_PASSWORD_SUCCESSFULLY,
  })
  @ApiBody({ schema: USER_SWAGGERS_DATA.CHANGE_PASSWORD_SCHEMA })
  @SwaggerResponse({
    status: StatusCodes.OK,
    description: USER_SWAGGER_MESSAGES.CHANGE_PASSWORD_SUCCESSFULLY,
  })
  async changePasswordController(
    @CurrentUser() user: Record<string, string>,
    @Body(new ZodValidationPipe(changePasswordSchema))
    changePasswordDto: ChangePasswordValues,
  ) {
    return await this.userService.changePasswordService(user.id, changePasswordDto);
  }
}
