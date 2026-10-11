import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from 'src/packages/guards/roles.guard';
import { JwtUserRole } from '@packages/helpers';

// `@packages/decorators` re-exports the decorators barrel; stub the ROLES_KEY constant lookup
// through the real Reflector so the guard reads metadata exactly as the decorator writes it.
import { ROLES_KEY, Roles } from '@packages/decorators';

class Probe {
  @Roles('ADMIN')
  adminOnly() {
    return undefined;
  }

  @Roles('ADMIN', 'TUTOR')
  staffOnly() {
    return undefined;
  }

  open() {
    return undefined;
  }
}

describe('RolesGuard', () => {
  const reflector = new Reflector();
  const guard = new RolesGuard(reflector);

  const contextFor = (handler: keyof Probe, user?: { role: JwtUserRole }) => {
    const request = { user };
    return {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => Probe.prototype[handler],
      getClass: () => Probe,
    } as unknown as ExecutionContext;
  };

  it('writes the roles metadata that the guard reads', () => {
    expect(Reflect.getMetadata(ROLES_KEY, Probe.prototype.staffOnly)).toEqual(['ADMIN', 'TUTOR']);
  });

  it.each<[keyof Probe, JwtUserRole | undefined, boolean]>([
    ['adminOnly', 'ADMIN', true],
    ['adminOnly', 'TUTOR', false],
    ['adminOnly', 'STUDENT', false],
    ['adminOnly', 'PARENT', false],
    ['staffOnly', 'TUTOR', true],
    ['staffOnly', 'STUDENT', false],
    ['open', 'STUDENT', true],
    ['open', undefined, true],
  ])('%s with role %s -> allowed=%s', (handler, role, allowed) => {
    const ctx = contextFor(handler, role ? { role } : undefined);
    if (allowed) {
      expect(guard.canActivate(ctx)).toBe(true);
    } else {
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    }
  });

  it('rejects a protected route when there is no authenticated user at all', () => {
    expect(() => guard.canActivate(contextFor('adminOnly', undefined))).toThrow(ForbiddenException);
  });
});
