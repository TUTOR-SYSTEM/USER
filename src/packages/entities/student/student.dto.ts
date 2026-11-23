import { z } from 'zod';
import {
  createStudentSchema,
  updateStudentSchema,
  getStudentsQuerySchema,
  getParentsQuerySchema,
} from './student.schema';

export type CreateStudentDto = z.infer<typeof createStudentSchema>;
export type UpdateStudentDto = z.infer<typeof updateStudentSchema>;
export type GetStudentsQueryDto = z.infer<typeof getStudentsQuerySchema>;
export type GetParentsQueryDto = z.infer<typeof getParentsQuerySchema>;

export type StudentParentResponseDto = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  relationship: string | null;
  userCode: string | null;
  avatar: string | null;
  address: string | null;
  district: string | null;
  province: string | null;
};

export type StudentClassResponseDto = {
  id: string;
  name: string;
  code: string;
};

export type StudentTutorResponseDto = {
  id: string;
  firstName: string;
  lastName: string;
  userCode: string | null;
  email: string;
  phone: string | null;
  avatar: string | null;
};

export type StudentResponseDto = {
  id: string;
  email: string;
  username: string;
  firstName: string;
  lastName: string;
  userCode: string | null;
  phone: string | null;
  avatar: string | null;
  gender: string | null;
  dateOfBirth: string | null;
  school: string | null;
  address: string | null;
  district: string | null;
  province: string | null;
  parentId: string | null;
  parentName: string | null;
  parentPhone: string | null;
  parentEmail: string | null;
  parentRelationship: string | null;
  parent: StudentParentResponseDto | null;
  tutorId: string | null;
  tutor: StudentTutorResponseDto | null;
  role: string | null;
  isActive: boolean | null;
  classes: StudentClassResponseDto[];
  classCount: number;
  score: string | null;
  createdAt: string;
  updatedAt: string;
};
