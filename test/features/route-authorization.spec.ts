import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ROLES_KEY } from '@packages/decorators';
import { UserController } from 'src/features/user/user.controller';
import { AdminController } from 'src/features/admin/admin.controller';

// The controllers inject services whose modules pull in Drizzle + `@packages/database/schema`
// (unresolvable by this jest config). Only the class tokens are needed to read route metadata.
// The `@packages/guards` barrel re-exports JwtAuthGuard, which imports the Drizzle schema alias.
// Only the guard class tokens are needed for `@UseGuards(...)`, so the barrel is stubbed.
jest.mock('@packages/guards', () => ({
  JwtAuthGuard: class JwtAuthGuard {},
  RolesGuard: class RolesGuard {},
  AdminRoleGuard: class AdminRoleGuard {},
  LanguageGuard: class LanguageGuard {},
}));
jest.mock('src/features/user/user.service', () => ({ UserService: class UserService {} }));
jest.mock('src/features/admin/admin.service', () => ({ AdminService: class AdminService {} }));

type RouteKey = string;

/** Reads "HTTP_METHOD path" -> required roles (undefined = any authenticated user) from metadata. */
function routeTable(
  controller: { prototype: object },
  classRoles?: string[],
): Map<RouteKey, string[] | undefined> {
  const table = new Map<RouteKey, string[] | undefined>();
  for (const name of Object.getOwnPropertyNames(controller.prototype)) {
    if (name === 'constructor') continue;
    const handler = (controller.prototype as Record<string, unknown>)[name] as object;
    const verb = Reflect.getMetadata(METHOD_METADATA, handler);
    if (verb === undefined) continue;
    const path = Reflect.getMetadata(PATH_METADATA, handler) as string;
    // Nest stores the verb as a RequestMethod enum number; map it back to its name.
    const roles = (Reflect.getMetadata(ROLES_KEY, handler) as string[] | undefined) ?? classRoles;
    table.set(`${RequestMethod[verb as RequestMethod]} ${path}`, roles);
  }
  return table;
}

describe('route authorization metadata (HTTP controllers)', () => {
  describe('UserController', () => {
    const table = routeTable(UserController);

    it.each([
      // Self-service routes: any authenticated user, scoped by @CurrentUser() in the handler.
      ['GET getDetailUser', undefined],
      ['PUT updateUser', undefined],
      ['POST changePassword', undefined],
      // Admin-only routes.
      ['GET getUsers', ['ADMIN']],
      ['GET getUserByField', ['ADMIN']],
      ['POST createUser', ['ADMIN']],
      ['PUT updateUserByAdmin/:id', ['ADMIN']],
      ['PUT updateStatusUser/:id', ['ADMIN']],
      ['DELETE deleteUserByAdmin/:id', ['ADMIN']],
    ])('%s requires %j', (key, roles) => {
      expect(table.has(key)).toBe(true);
      expect(table.get(key)).toEqual(roles);
    });

    it('exposes no route that is missing from the matrix above', () => {
      expect([...table.keys()].sort()).toEqual(
        [
          'GET getDetailUser',
          'PUT updateUser',
          'POST changePassword',
          'GET getUsers',
          'GET getUserByField',
          'POST createUser',
          'PUT updateUserByAdmin/:id',
          'PUT updateStatusUser/:id',
          'DELETE deleteUserByAdmin/:id',
        ].sort(),
      );
    });
  });

  describe('AdminController', () => {
    const table = routeTable(AdminController, Reflect.getMetadata(ROLES_KEY, AdminController));

    it('applies ADMIN at class level so every managed-user route is admin-only', () => {
      expect(Reflect.getMetadata(ROLES_KEY, AdminController)).toEqual(['ADMIN']);
      expect(table.size).toBeGreaterThan(0);
      for (const [key, roles] of table) {
        expect({ key, roles }).toEqual({ key, roles: ['ADMIN'] });
      }
    });

    it('covers tutor and student CRUD endpoints', () => {
      expect([...table.keys()].sort()).toEqual(
        [
          'POST createTutor',
          'GET listTutors',
          'GET getTutor/:id',
          'PUT updateTutor/:id',
          'DELETE deleteTutor/:id',
          'POST createStudent',
          'GET listStudents',
          'GET getStudent/:id',
          'PUT updateStudent/:id',
          'DELETE deleteStudent/:id',
        ].sort(),
      );
    });
  });
});
