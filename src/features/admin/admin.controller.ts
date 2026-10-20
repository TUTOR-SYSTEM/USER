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
import { CurrentUser, Roles } from '@packages/decorators';
import { actorFrom } from '../user/user.service';
import { RolesGuard } from '@packages/guards';
import { ZodValidationPipe } from '@packages/pipes';
import {
  createManagedUserSchema,
  updateManagedUserSchema,
  updateManagedStudentSchema,
  listManagedUsersQuerySchema,
  type CreateManagedUserDto,
  type UpdateManagedUserDto,
  type UpdateManagedStudentDto,
  type ListManagedUsersQueryDto,
} from '@packages/entities/admin';
import { AdminService } from './admin.service';

const CREATE_ACCOUNT_BODY_SCHEMA = {
  type: 'object',
  required: ['email', 'firstName', 'lastName', 'password'],
  properties: {
    email: { type: 'string', format: 'email', example: 'user@example.com' },
    username: { type: 'string', maxLength: 50, example: 'nguyenvana' },
    firstName: { type: 'string', minLength: 2, maxLength: 100, example: 'Nguyen' },
    lastName: { type: 'string', minLength: 2, maxLength: 100, example: 'Van A' },
    password: { type: 'string', minLength: 8, maxLength: 14, example: 'Pass1234!' },
    phone: { type: 'string', maxLength: 20, example: '0987654321' },
    gender: { type: 'string', enum: ['MALE', 'FEMALE', 'OTHER'], example: 'MALE' },
    dateOfBirth: { type: 'string', format: 'date-time', example: '2000-01-15T00:00:00.000Z' },
    school: { type: 'string', maxLength: 255, example: 'THPT Le Hong Phong' },
    subjects: {
      type: 'array',
      items: { type: 'string' },
      example: ['Toán', 'Vật lý'],
      description: 'Danh sách môn dạy (chọn nhiều)',
    },
    description: { type: 'string', maxLength: 5000, example: 'Short bio' },
    isActive: { type: 'boolean', example: true },
  },
};

const UPDATE_ACCOUNT_BODY_SCHEMA = {
  type: 'object',
  properties: {
    email: { type: 'string', format: 'email', example: 'updated@example.com' },
    username: { type: 'string', maxLength: 50, example: 'newusername' },
    firstName: { type: 'string', minLength: 2, maxLength: 100, example: 'Nguyen' },
    lastName: { type: 'string', minLength: 2, maxLength: 100, example: 'Van A' },
    phone: { type: 'string', maxLength: 20, nullable: true, example: '0987654321' },
    gender: { type: 'string', enum: ['MALE', 'FEMALE', 'OTHER'], nullable: true, example: 'MALE' },
    dateOfBirth: { type: 'string', format: 'date-time', nullable: true },
    school: { type: 'string', maxLength: 255, nullable: true, example: 'THPT Le Hong Phong' },
    subjects: {
      type: 'array',
      items: { type: 'string' },
      nullable: true,
      example: ['Toán', 'Vật lý'],
      description: 'Danh sách môn dạy (chọn nhiều); mảng rỗng/null để xoá',
    },
    description: { type: 'string', maxLength: 5000, nullable: true, example: 'Short bio' },
    avatar: { type: 'string', format: 'uri', nullable: true },
    isActive: { type: 'boolean', example: true },
  },
};

const UPDATE_STUDENT_BODY_SCHEMA = {
  type: 'object',
  properties: {
    ...UPDATE_ACCOUNT_BODY_SCHEMA.properties,
    userCode: { type: 'string', maxLength: 6, example: 'STU001' },
    address: { type: 'string', nullable: true, example: '123 Le Loi' },
    district: { type: 'string', maxLength: 30, nullable: true, example: 'Quan 1' },
    province: { type: 'string', maxLength: 30, nullable: true, example: 'TP HCM' },
    parentId: { type: 'string', format: 'uuid', nullable: true },
    tutorId: { type: 'string', format: 'uuid', nullable: true },
  },
};

/**
 * Admin-only management of tutor and student accounts.
 *
 * Every route is protected by the global `JwtAuthGuard` (authentication) plus a
 * controller-level `RolesGuard` + `@Roles('ADMIN')` (authorization) — only users
 * whose JWT carries `role: ADMIN` may reach any handler here.
 */
@ApiTags('Admin')
@ApiBearerAuth('access-token')
@UseGuards(RolesGuard)
@Roles('ADMIN')
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  // ─── Tutors ────────────────────────────────────────────────────────
  @Post('tutors')
  @HttpCode(StatusCodes.CREATED)
  @ApiOperation({ summary: 'Create tutor', description: 'Create a new TUTOR account (admin only)' })
  @ApiBody({ schema: CREATE_ACCOUNT_BODY_SCHEMA })
  @SwaggerResponse({ status: 201, description: 'Tutor created' })
  createTutor(
    @CurrentUser() user: Record<string, string>,
    @Body(new ZodValidationPipe(createManagedUserSchema)) dto: CreateManagedUserDto,
  ) {
    return this.adminService.createTutor(dto, actorFrom(user));
  }

  @Get('tutors')
  @HttpCode(StatusCodes.OK)
  @ApiOperation({ summary: 'List tutors', description: 'Paginated list of tutors (admin only)' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Search name/email/phone',
  })
  @ApiQuery({ name: 'isActive', required: false, enum: ['true', 'false'] })
  @SwaggerResponse({ status: 200, description: 'Tutors fetched' })
  listTutors(
    @CurrentUser() user: Record<string, string>,
    @Query(new ZodValidationPipe<ListManagedUsersQueryDto>(listManagedUsersQuerySchema))
    query: ListManagedUsersQueryDto,
  ) {
    return this.adminService.listTutors(query, actorFrom(user));
  }

  @Get('tutors/:id')
  @HttpCode(StatusCodes.OK)
  @ApiOperation({ summary: 'Get tutor detail' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @SwaggerResponse({ status: 200, description: 'Tutor detail' })
  @SwaggerResponse({ status: 404, description: 'Tutor not found' })
  getTutor(@CurrentUser() user: Record<string, string>, @Param('id') id: string) {
    return this.adminService.getTutor(id, actorFrom(user));
  }

  @Put('tutors/:id')
  @HttpCode(StatusCodes.OK)
  @ApiOperation({ summary: 'Update tutor' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiBody({ schema: UPDATE_ACCOUNT_BODY_SCHEMA })
  @SwaggerResponse({ status: 200, description: 'Tutor updated' })
  updateTutor(
    @CurrentUser() user: Record<string, string>,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateManagedUserSchema)) dto: UpdateManagedUserDto,
  ) {
    return this.adminService.updateTutor(id, dto, actorFrom(user));
  }

  @Delete('tutors/:id')
  @HttpCode(StatusCodes.OK)
  @ApiOperation({ summary: 'Delete tutor' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @SwaggerResponse({ status: 200, description: 'Tutor deleted' })
  deleteTutor(@CurrentUser() user: Record<string, string>, @Param('id') id: string) {
    return this.adminService.deleteTutor(id, actorFrom(user));
  }

  // ─── Students ──────────────────────────────────────────────────────
  @Post('students')
  @HttpCode(StatusCodes.CREATED)
  @ApiOperation({
    summary: 'Create student',
    description: 'Create a new STUDENT account (admin only)',
  })
  @ApiBody({ schema: CREATE_ACCOUNT_BODY_SCHEMA })
  @SwaggerResponse({ status: 201, description: 'Student created' })
  createStudent(
    @CurrentUser() user: Record<string, string>,
    @Body(new ZodValidationPipe(createManagedUserSchema)) dto: CreateManagedUserDto,
  ) {
    return this.adminService.createStudent(dto, actorFrom(user));
  }

  @Get('students')
  @HttpCode(StatusCodes.OK)
  @ApiOperation({
    summary: 'List students',
    description: 'Paginated list of students (admin only)',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Search name/email/phone',
  })
  @ApiQuery({ name: 'isActive', required: false, enum: ['true', 'false'] })
  @SwaggerResponse({ status: 200, description: 'Students fetched' })
  listStudents(
    @CurrentUser() user: Record<string, string>,
    @Query(new ZodValidationPipe<ListManagedUsersQueryDto>(listManagedUsersQuerySchema))
    query: ListManagedUsersQueryDto,
  ) {
    return this.adminService.listStudents(query, actorFrom(user));
  }

  @Get('students/:id')
  @HttpCode(StatusCodes.OK)
  @ApiOperation({ summary: 'Get student detail' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @SwaggerResponse({ status: 200, description: 'Student detail' })
  @SwaggerResponse({ status: 404, description: 'Student not found' })
  getStudent(@CurrentUser() user: Record<string, string>, @Param('id') id: string) {
    return this.adminService.getStudent(id, actorFrom(user));
  }

  @Put('students/:id')
  @HttpCode(StatusCodes.OK)
  @ApiOperation({
    summary: 'Update student',
    description: 'Admin update of a student — every profile field is editable.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiBody({ schema: UPDATE_STUDENT_BODY_SCHEMA })
  @SwaggerResponse({ status: 200, description: 'Student updated' })
  updateStudent(
    @CurrentUser() user: Record<string, string>,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateManagedStudentSchema)) dto: UpdateManagedStudentDto,
  ) {
    return this.adminService.updateStudent(id, dto, actorFrom(user));
  }

  @Delete('students/:id')
  @HttpCode(StatusCodes.OK)
  @ApiOperation({ summary: 'Delete student' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @SwaggerResponse({ status: 200, description: 'Student deleted' })
  deleteStudent(@CurrentUser() user: Record<string, string>, @Param('id') id: string) {
    return this.adminService.deleteStudent(id, actorFrom(user));
  }
}
