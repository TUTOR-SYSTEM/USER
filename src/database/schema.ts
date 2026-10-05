// Local mirror of the USER-owned tables (users, grades) from ../gateway/src/database/schema.ts,
// which stays the canonical schema + migration owner. Kept local so the Docker build doesn't need
// the `file:../gateway` package. Keep in sync with gateway when either table/enum changes.
import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  boolean,
  pgEnum,
  integer,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

export const userRoleEnum = pgEnum('user_role', ['STUDENT', 'ADMIN', 'TUTOR', 'PARENT']);
export const genderEnum = pgEnum('gender', ['MALE', 'FEMALE', 'OTHER']);

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  username: varchar('username', { length: 50 }).notNull().unique(),
  firstName: varchar('first_name', { length: 255 }).notNull(),
  lastName: varchar('last_name', { length: 255 }).notNull(),
  password: text('password').notNull(),
  avatar: text('avatar'),
  phone: varchar('phone', { length: 20 }),
  isActive: boolean('is_active').default(true),
  role: userRoleEnum('role').default('STUDENT'),
  description: varchar('description', { length: 5000 }),
  userCode: varchar('userCode', { length: 6 }),
  gender: genderEnum('gender'),
  dateOfBirth: timestamp('date_of_birth'),
  address: text('address'),
  district: varchar('district', { length: 30 }),
  province: varchar('province', { length: 30 }),
  subjects: varchar('subjects', { length: 255 }),
  facebookId: varchar('facebookUrl', { length: 200 }),
  googleId: varchar('googleUrl', { length: 200 }),
  school: varchar('school', { length: 255 }),
  relationship: varchar('relationship', { length: 50 }),
  gradesId: uuid('grades_id').array().notNull().default([]),
  parentId: uuid('parent_id').references((): AnyPgColumn => users.id, { onDelete: 'cascade' }),
  tutorId: uuid('tutor_id').references((): AnyPgColumn => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const grades = pgTable('grades', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 50 }).notNull().unique(),
  level: integer('level').notNull().unique(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
