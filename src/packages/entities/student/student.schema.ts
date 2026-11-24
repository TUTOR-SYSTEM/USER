import { z } from 'zod';

/** Mật khẩu do gia sư/admin đặt: 8–100 ký tự, đủ chữ thường, chữ hoa, số, ký tự đặc biệt (khớp auth). */
export const studentPasswordSchema = z
  .string({ message: 'Password is required' })
  .min(8, { message: 'Password must be at least 8 characters' })
  .max(100, { message: 'Password must not exceed 100 characters' })
  .regex(/[a-z]/, { message: 'Password must contain a lowercase letter' })
  .regex(/[A-Z]/, { message: 'Password must contain an uppercase letter' })
  .regex(/\d/, { message: 'Password must contain a number' })
  .regex(/[^A-Za-z0-9]/, { message: 'Password must contain a special character' });

export const createStudentSchema = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email').optional(),
  // Tùy chọn: không gửi thì BE sinh mật khẩu ngẫu nhiên (không trả về).
  password: studentPasswordSchema.optional(),
  // Mật khẩu cho phụ huynh MỚI được tạo cùng học sinh (không áp dụng khi liên kết parentId có sẵn).
  parentPassword: studentPasswordSchema.optional(),
  studentName: z
    .string({ message: 'Student name must be required ...' })
    .min(1, { message: 'Student name must be 1 character ...' })
    .max(255, { message: 'Student name must not over 255 character ...' }),
  // `users.userCode` is VarChar(6): a longer value would fail inside Postgres (500).
  userCode: z
    .string()
    .min(1, 'Code is required')
    .max(6, 'Code must be at most 6 characters')
    .optional(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(),
  studentPhone: z.string().max(20).optional(),
  school: z.string().max(255).optional(),
  parentId: z.string().uuid({ message: 'Parent id must be uuid' }).optional(),
  parentName: z
    .string({ message: 'Parent name must be required ...' })
    .min(1, { message: 'Parent name must be 1 character ...' })
    .max(255, { message: 'Parent name must not over 255 character ...' })
    .optional(),
  parentRelationship: z.enum(['FATHER', 'MOTHER', 'GUARDIAN']).optional(),
  parentPhone: z.string().max(20).optional(),
  parentEmail: z.string().trim().toLowerCase().email('Invalid parent email').optional(),
  // Gia sư quản lý. Bắt buộc khi ADMIN tạo; TUTOR thì luôn là chính mình (service quyết định).
  tutorId: z.string().uuid({ message: 'Tutor id must be uuid' }).optional(),
});

export const updateStudentSchema = z.object({
  studentName: z.string().min(1).max(255).optional(),
  // Họ (lastName) và Tên (firstName) tách riêng; ưu tiên hơn `studentName` (giữ để tương thích ngược).
  lastName: z.string().trim().min(1).max(255).optional(),
  firstName: z.string().trim().min(1).max(255).optional(),
  // Chuyển học sinh sang gia sư khác (chỉ ADMIN).
  tutorId: z.string().uuid({ message: 'Tutor id must be uuid' }).optional(),
  studentPhone: z.string().max(20).optional(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(),
  birthday: z.coerce.date().optional(),
  school: z.string().max(255).optional(),
  address: z.string().max(500).optional(),
  district: z.string().max(30).optional(),
  province: z.string().max(30).optional(),
  parentId: z.string().uuid({ message: 'Parent id must be uuid' }).optional(),
  parentName: z.string().min(1).max(255).optional(),
  // Họ/Tên phụ huynh tách riêng; ưu tiên hơn `parentName`.
  parentLastName: z.string().trim().min(1).max(255).optional(),
  parentFirstName: z.string().trim().min(1).max(255).optional(),
  parentPhone: z.string().max(20).optional(),
  parentEmail: z.string().trim().toLowerCase().email('Invalid parent email').optional(),
  parentRelationship: z.enum(['FATHER', 'MOTHER', 'GUARDIAN']).optional(),
  parentAddress: z.string().max(500).optional(),
  parentDistrict: z.string().max(30).optional(),
  parentProvince: z.string().max(30).optional(),
  avatar: z
    .string()
    .url()
    .regex(/^https?:\/\//i, { message: 'Avatar must be an http(s) URL' })
    .regex(/\.(jpe?g|png|webp|gif)(\?.*)?$/i, {
      message: 'Avatar must be an image (jpg, png, webp, gif)',
    })
    .optional()
    .nullable(),
});

export const setStudentPasswordSchema = z.object({
  password: studentPasswordSchema,
});

/** Parent picker search: PARENT accounts a staff member may attach to a student. */
export const getParentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  search: z.string().trim().min(1).max(100).optional(),
});

export const getStudentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().trim().min(1).max(100).optional(),
  tutorId: z.string().uuid('Invalid tutor ID').optional(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(),
  // `z.coerce.boolean()` treats the string "false" as truthy — use an explicit enum instead so
  // `?isActive=false` from the query string actually filters to inactive students.
  isActive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});
