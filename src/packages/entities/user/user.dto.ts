import type { z } from 'zod';
import {
  createUserSchema,
  dataFieldSchema,
  getUsersQuerySchema,
  updateGradeSchema,
  updateUserGradesSchema,
  updateUserSchema,
} from './user.schema';

// ?params: export type from schemas
export type GetUsersQueryDto = z.infer<typeof getUsersQuerySchema>;
export type UserDataFieldDto = z.infer<typeof dataFieldSchema>;
export type CreateUserDto = z.infer<typeof createUserSchema>;
/**
 * Pre-validation shape accepted by `createUserService`. Uses `z.input` so the
 * schema's defaulted fields (isActive, description, address, ...) are optional
 * for direct callers (e.g. auth register / OAuth), while the parsed output type
 * `CreateUserDto` — which the controller passes — remains assignable to it.
 */
export type CreateUserInput = z.input<typeof createUserSchema>;
export type UpdateUserDto = z.infer<typeof updateUserSchema>;
export type ChangePasswordValues = {
  currentPassword: string;
  newPassword: string;
};

// ?params: init type not init from schemas
export type User = {
  id: string;
  userCode: string | null;
  email: string;
  username: string;
  firstName: string;
  lastName: string;
  password: string;
  avatar: string | null;
  phone: string | null;
  isActive: boolean | null;
  role: string | null;
  gradesId: string[];
  createdAt: Date;
  updatedAt: Date;
};

export type UserListResponseDto = {
  message: string;
  query: GetUsersQueryDto;
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
  data: User[];
};

export type UpdateGradeDto = z.infer<typeof updateGradeSchema>;
export type UpdateUserGradesDto = z.infer<typeof updateUserGradesSchema>;

export type CreateUserResponseDto = {
  message: string;
  data: {
    email: string;
    fullName: string;
  };
};
