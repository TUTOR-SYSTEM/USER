import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AdminRoleGuard } from 'src/packages/guards/admin-role.guard';
import type { JwtGuardUser } from 'src/packages/guards/jwt-auth.guard';

describe('AdminRoleGuard', () => {
  const guard = new AdminRoleGuard();

  const ctxWith = (user?: Partial<JwtGuardUser>) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as unknown as ExecutionContext;

  const userWithRole = (role: JwtGuardUser['role']): JwtGuardUser => ({
    id: '11111111-1111-4111-8111-111111111111',
    email: 'u@example.com',
    typ: 'access',
    role,
  });

  it('allows an ADMIN', () => {
    expect(guard.canActivate(ctxWith(userWithRole('ADMIN')))).toBe(true);
  });

  it.each(['TUTOR', 'STUDENT', 'PARENT'] as const)('rejects %s with Forbidden', (role) => {
    expect(() => guard.canActivate(ctxWith(userWithRole(role)))).toThrow(ForbiddenException);
  });

  it('rejects when no user is attached to the request', () => {
    expect(() => guard.canActivate(ctxWith(undefined))).toThrow(ForbiddenException);
  });

  it('rejects a user object that lacks a role', () => {
    expect(() =>
      guard.canActivate(ctxWith({ id: 'x', email: 'a@b.c', typ: 'access' } as never)),
    ).toThrow('Admin role required ...');
  });
});
