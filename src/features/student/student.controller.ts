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
  createStudentSchema,
  type CreateStudentDto,
  getStudentsQuerySchema,
  type GetStudentsQueryDto,
  updateStudentSchema,
  type UpdateStudentDto,
} from '@packages/entities/student';
import type { JwtGuardUser } from '../../packages/guards/jwt-auth.guard';
import { actorFrom } from '../user/user.service';
import { StudentService } from './student.service';

/**
 * Every route is limited to staff (ADMIN/TUTOR); the list is ADMIN-only and update/delete are
 * ADMIN-only, matching the RPC rule that only an admin or the user themself may change a user.
 */
@ApiTags('Students')
@ApiBearerAuth('access-token')
@UseGuards(RolesGuard)
@Roles('ADMIN', 'TUTOR')
@Controller('student')
export class StudentController {
  constructor(private readonly studentService: StudentService) {}

  //TODO: generate unique code controller ...
  @Get('generateCode')
  @HttpCode(StatusCodes.OK)
  @ApiOperation({
    summary: 'Generate student code for new student ...',
    description: 'Generate student code ...',
  })
  @SwaggerResponse({ status: 201, description: 'Student created' })
  async generateStudentCodeController() {
    return await this.studentService.generateStudentCodeService();
  }

  //todo : create new student and parent controller ...
  @Post('create')
  @HttpCode(StatusCodes.CREATED)
  @ApiOperation({
    summary: 'Create student',
    description:
      'Create a new student. If parentName provided, a PARENT user is auto-created and linked. Creator (tutor/admin) is recorded on the student record.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['studentName'],
      properties: {
        email: {
          type: 'string',
          format: 'email',
          example: 'student@example.com',
        },
        studentName: {
          type: 'string',
          example: 'Nguyen Van A',
        },
        userCode: {
          type: 'string',
          example: 'STU001',
        },
        gender: {
          type: 'string',
          enum: ['MALE', 'FEMALE', 'OTHER'],
          example: 'MALE',
        },
        studentPhone: {
          type: 'string',
          example: '0987654321',
        },
        school: {
          type: 'string',
          example: 'ABC High School',
        },
        parentId: {
          type: 'string',
          format: 'uuid',
          description: 'Link an existing PARENT instead of creating one from parentName',
        },
        parentName: {
          type: 'string',
          example: 'Nguyen Van B',
        },
        parentRelationship: {
          type: 'string',
          enum: ['FATHER', 'MOTHER', 'GUARDIAN'],
          example: 'FATHER',
        },
        parentPhone: {
          type: 'string',
          example: '0912345678',
        },
        parentEmail: {
          type: 'string',
          format: 'email',
          example: 'parent@example.com',
        },
      },
    },
  })
  @SwaggerResponse({ status: 201, description: 'Student created' })
  create(
    @Body(new ZodValidationPipe(createStudentSchema))
    dto: CreateStudentDto,
    @CurrentUser() currentUser: JwtGuardUser,
  ) {
    return this.studentService.create(dto, actorFrom(currentUser));
  }

  @Get('findAll')
  @Roles('ADMIN')
  @HttpCode(StatusCodes.OK)
  @ApiOperation({ summary: 'List students', description: 'Get paginated list of students' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiQuery({ name: 'search', required: false, type: String, description: 'Search by name/code' })
  @ApiQuery({
    name: 'tutorId',
    required: false,
    type: String,
    format: 'uuid',
    description: 'Filter to students managed by this tutor',
  })
  @ApiQuery({
    name: 'gender',
    required: false,
    enum: ['MALE', 'FEMALE', 'OTHER'],
    description: 'Filter by gender',
  })
  @ApiQuery({
    name: 'isActive',
    required: false,
    enum: ['true', 'false'],
    description: 'Filter by active status',
  })
  @SwaggerResponse({ status: 200, description: 'Students fetched' })
  async getAllStudents(
    @CurrentUser() user: JwtGuardUser,
    @Query(new ZodValidationPipe<GetStudentsQueryDto>(getStudentsQuerySchema))
    query: GetStudentsQueryDto,
  ) {
    return this.studentService.findAll(query, actorFrom(user));
  }

  @Get('findById/:id')
  @HttpCode(StatusCodes.OK)
  @ApiOperation({
    summary: 'Get student detail',
    description: 'Get student detail',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @SwaggerResponse({
    status: 200,
    description: 'Student detail',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        email: { type: 'string', format: 'email' },
        username: { type: 'string' },
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        userCode: { type: 'string', nullable: true },
        phone: { type: 'string', nullable: true },
        avatar: { type: 'string', nullable: true },
        gender: { type: 'string', enum: ['MALE', 'FEMALE', 'OTHER'], nullable: true },
        dateOfBirth: { type: 'string', format: 'date-time', nullable: true },
        school: { type: 'string', nullable: true },
        address: { type: 'string', nullable: true },
        district: { type: 'string', nullable: true },
        province: { type: 'string', nullable: true },
        parentId: { type: 'string', format: 'uuid', nullable: true },
        parentName: { type: 'string', nullable: true },
        parentPhone: { type: 'string', nullable: true },
        parentEmail: { type: 'string', nullable: true },
        parentRelationship: {
          type: 'string',
          enum: ['FATHER', 'MOTHER', 'GUARDIAN'],
          nullable: true,
        },
        parent: {
          type: 'object',
          nullable: true,
          properties: {
            id: { type: 'string', format: 'uuid' },
            firstName: { type: 'string' },
            lastName: { type: 'string' },
            email: { type: 'string' },
            phone: { type: 'string', nullable: true },
            relationship: {
              type: 'string',
              enum: ['FATHER', 'MOTHER', 'GUARDIAN'],
              nullable: true,
            },
            userCode: { type: 'string', nullable: true },
            avatar: { type: 'string', nullable: true },
            address: { type: 'string', nullable: true },
            district: { type: 'string', nullable: true },
            province: { type: 'string', nullable: true },
          },
        },
        role: { type: 'string' },
        isActive: { type: 'boolean' },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @SwaggerResponse({ status: 404, description: 'Student not found' })
  async findById(@CurrentUser() user: JwtGuardUser, @Param('id') id: string) {
    return this.studentService.findById(id, actorFrom(user));
  }

  @Put('update/:id')
  @Roles('ADMIN')
  @HttpCode(StatusCodes.OK)
  @ApiOperation({ summary: 'Update student' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        studentName: { type: 'string', maxLength: 255, example: 'Nguyen Van A' },
        studentPhone: { type: 'string', example: '0912345678' },
        gender: { type: 'string', enum: ['MALE', 'FEMALE', 'OTHER'], example: 'MALE' },
        birthday: {
          type: 'string',
          format: 'date-time',
          example: '2008-05-20T00:00:00.000Z',
        },
        school: { type: 'string', maxLength: 255, example: 'THPT Quang Trung' },
        address: { type: 'string', maxLength: 500, example: '123 Nguyen Trai' },
        district: { type: 'string', maxLength: 30, example: 'Thanh Xuan' },
        province: { type: 'string', maxLength: 30, example: 'Ha Noi' },
        parentId: { type: 'string', format: 'uuid', nullable: true },
        parentName: { type: 'string', maxLength: 255, example: 'Tran Thi B' },
        parentPhone: { type: 'string', example: '0987654321' },
        parentEmail: { type: 'string', format: 'email', example: 'phuhuynh@gmail.com' },
        parentRelationship: {
          type: 'string',
          enum: ['FATHER', 'MOTHER', 'GUARDIAN'],
          example: 'FATHER',
        },
        parentAddress: { type: 'string', maxLength: 500, example: '123 Nguyen Trai' },
        parentDistrict: { type: 'string', maxLength: 30, example: 'Thanh Xuan' },
        parentProvince: { type: 'string', maxLength: 30, example: 'Ha Noi' },
        avatar: { type: 'string', format: 'url', nullable: true },
      },
    },
  })
  @SwaggerResponse({ status: 200, description: 'Student updated' })
  async update(
    @CurrentUser() user: JwtGuardUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateStudentSchema))
    dto: UpdateStudentDto,
  ) {
    return this.studentService.update(id, dto, actorFrom(user));
  }

  @Delete('delete/:id')
  @Roles('ADMIN')
  @HttpCode(StatusCodes.OK)
  @ApiOperation({ summary: 'Delete student' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @SwaggerResponse({ status: 200, description: 'Student deleted' })
  async delete(@CurrentUser() user: JwtGuardUser, @Param('id') id: string) {
    return this.studentService.delete(id, actorFrom(user));
  }
}
