/**
 * Seed 3 TUTOR accounts and 10 STUDENT accounts, with each student assigned to a tutor
 * (round-robin via `tutorId`). Idempotent: existing emails/usernames are skipped.
 *
 * Usage: bun scripts/seed-tutors-students.ts
 * Optional:
 *   SEED_PASSWORD='Test@12345' (shared password, min 8 chars)
 *   SEED_EMAIL_DOMAIN=example.test (default example.test)
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { createPrismaClient } from './lib/prisma';
import { hashData } from '../src/packages/helpers/hashingData.helper';
import { generateCode } from '../src/packages/helpers/generate.helper';
import type { PrismaClient } from '../src/generated/prisma/client';

const TUTORS = [
  {
    username: 'tutor01',
    firstName: 'Minh',
    lastName: 'Nguyễn',
    gender: 'MALE' as const,
    subjects: 'Toán, Vật lý',
    school: 'Đại học Bách Khoa Hà Nội',
    district: 'Hai Bà Trưng',
    province: 'Hà Nội',
  },
  {
    username: 'tutor02',
    firstName: 'Lan',
    lastName: 'Trần',
    gender: 'FEMALE' as const,
    subjects: 'Ngữ văn, Tiếng Anh',
    school: 'Đại học Sư phạm TP.HCM',
    district: 'Quận 3',
    province: 'TP. Hồ Chí Minh',
  },
  {
    username: 'tutor03',
    firstName: 'Hùng',
    lastName: 'Lê',
    gender: 'MALE' as const,
    subjects: 'Hóa học, Sinh học',
    school: 'Đại học Khoa học Tự nhiên',
    district: 'Cầu Giấy',
    province: 'Hà Nội',
  },
];

const STUDENTS = [
  {
    username: 'student01',
    firstName: 'An',
    lastName: 'Phạm',
    gender: 'MALE' as const,
    school: 'THCS Lê Quý Đôn',
    district: 'Đống Đa',
    province: 'Hà Nội',
  },
  {
    username: 'student02',
    firstName: 'Bình',
    lastName: 'Hoàng',
    gender: 'MALE' as const,
    school: 'THPT Chu Văn An',
    district: 'Ba Đình',
    province: 'Hà Nội',
  },
  {
    username: 'student03',
    firstName: 'Chi',
    lastName: 'Đỗ',
    gender: 'FEMALE' as const,
    school: 'THCS Nguyễn Du',
    district: 'Hoàn Kiếm',
    province: 'Hà Nội',
  },
  {
    username: 'student04',
    firstName: 'Dũng',
    lastName: 'Vũ',
    gender: 'MALE' as const,
    school: 'THPT Lê Hồng Phong',
    district: 'Quận 5',
    province: 'TP. Hồ Chí Minh',
  },
  {
    username: 'student05',
    firstName: 'Hà',
    lastName: 'Bùi',
    gender: 'FEMALE' as const,
    school: 'THCS Trần Văn Ơn',
    district: 'Quận 1',
    province: 'TP. Hồ Chí Minh',
  },
  {
    username: 'student06',
    firstName: 'Khánh',
    lastName: 'Đặng',
    gender: 'OTHER' as const,
    school: 'THPT Nguyễn Thị Minh Khai',
    district: 'Quận 3',
    province: 'TP. Hồ Chí Minh',
  },
  {
    username: 'student07',
    firstName: 'Linh',
    lastName: 'Ngô',
    gender: 'FEMALE' as const,
    school: 'THCS Thái Thị Bôi',
    district: 'Thanh Xuân',
    province: 'Hà Nội',
  },
  {
    username: 'student08',
    firstName: 'Nam',
    lastName: 'Lý',
    gender: 'MALE' as const,
    school: 'THPT Trần Phú',
    district: 'Hoàng Mai',
    province: 'Hà Nội',
  },
  {
    username: 'student09',
    firstName: 'Phương',
    lastName: 'Đinh',
    gender: 'FEMALE' as const,
    school: 'THCS Nguyễn Huệ',
    district: 'Gò Vấp',
    province: 'TP. Hồ Chí Minh',
  },
  {
    username: 'student10',
    firstName: 'Quang',
    lastName: 'Trịnh',
    gender: 'MALE' as const,
    school: 'THPT Gia Định',
    district: 'Bình Thạnh',
    province: 'TP. Hồ Chí Minh',
  },
];

/** 6-char studentCode (`users.userCode`) that no other user holds yet. */
async function uniqueStudentCode(db: PrismaClient): Promise<string> {
  for (;;) {
    const code = generateCode(6);
    const taken = await db.user.findFirst({ where: { userCode: code }, select: { id: true } });
    if (!taken) return code;
  }
}

async function main(): Promise<void> {
  const password = process.env.SEED_PASSWORD?.trim() || 'Test@12345';
  const domain = (process.env.SEED_EMAIL_DOMAIN ?? 'example.test').trim() || 'example.test';
  if (password.length < 8) {
    console.error('SEED_PASSWORD must be at least 8 characters.');
    process.exit(1);
  }

  const db = createPrismaClient();
  const hashedPassword = await hashData(password);

  // 1. Tutors
  const tutorIds: string[] = [];
  for (const tutor of TUTORS) {
    const email = `${tutor.username}@${domain}`;
    const existing = await db.user.findFirst({
      where: {
        OR: [{ email: { equals: email, mode: 'insensitive' } }, { username: tutor.username }],
      },
      select: { id: true, role: true },
    });
    if (existing) {
      tutorIds.push(existing.id);
      console.log(`Skipped (already exists) [TUTOR]: ${email}`);
      continue;
    }
    const created = await db.user.create({
      data: {
        id: randomUUID(),
        email,
        username: tutor.username,
        firstName: tutor.firstName,
        lastName: tutor.lastName,
        password: hashedPassword,
        role: 'TUTOR',
        isActive: true,
        emailVerified: true,
        gender: tutor.gender,
        subjects: tutor.subjects,
        school: tutor.school,
        district: tutor.district,
        province: tutor.province,
      },
      select: { id: true },
    });
    tutorIds.push(created.id);
    console.log(`Created [TUTOR]: ${email}`);
  }

  // 2. Students, assigned round-robin to the tutors above
  for (let i = 0; i < STUDENTS.length; i++) {
    const student = STUDENTS[i];
    const email = `${student.username}@${domain}`;
    const existing = await db.user.findFirst({
      where: {
        OR: [{ email: { equals: email, mode: 'insensitive' } }, { username: student.username }],
      },
      select: { id: true, userCode: true },
    });
    if (existing) {
      // Backfill a studentCode for students seeded before codes were generated.
      if (!existing.userCode) {
        const userCode = await uniqueStudentCode(db);
        await db.user.update({ where: { id: existing.id }, data: { userCode } });
        console.log(`Set studentCode ${userCode} [STUDENT]: ${email}`);
      } else {
        console.log(`Skipped (already exists) [STUDENT]: ${email} (studentCode ${existing.userCode})`);
      }
      continue;
    }
    const tutorId = tutorIds[i % tutorIds.length];
    await db.user.create({
      data: {
        id: randomUUID(),
        email,
        username: student.username,
        firstName: student.firstName,
        lastName: student.lastName,
        password: hashedPassword,
        role: 'STUDENT',
        isActive: true,
        emailVerified: true,
        gender: student.gender,
        school: student.school,
        district: student.district,
        province: student.province,
        tutorId,
        userCode: await uniqueStudentCode(db),
      },
    });
    console.log(`Created [STUDENT]: ${email} (tutorId: ${tutorId})`);
  }

  console.log(`\nShared password: ${password}`);
  await db.$disconnect();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
