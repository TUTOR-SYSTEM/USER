import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { catchError, Observable, throwError } from 'rxjs';

export const INTERNAL_ERROR_MESSAGE = 'Internal server error';

@Injectable()
export class ErrorInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ErrorInterceptor.name);

  private resolveClientMessage(error: unknown): string {
    if (typeof error === 'object' && error !== null) {
      const e = error as Record<string, unknown>;
      const pgCode = (e.code ?? (e.cause as Record<string, unknown> | undefined)?.code) as
        string | undefined;
      switch (pgCode) {
        // Prisma known-request error codes (the driver adapter surfaces them instead of pg codes).
        case 'P2003':
        case '23503':
          return 'Referenced record not found (foreign key violation)';
        case 'P2002':
        case '23505':
          return 'Record already exists (duplicate value)';
        case 'P2011':
        case '23502':
          return 'Required field is missing (not-null violation)';
        case '23514':
          return 'Value violates check constraint';
      }
    }
    const message = error instanceof Error ? error.message : '';
    // ORM errors embed the failed query / invocation text — never echo that to clients.
    if (message.startsWith('Failed query:') || message.includes('Invalid `prisma.')) {
      return 'Database error';
    }
    // Any other unknown error may carry internal detail (SQL, config names, paths): the client gets a
    // generic text, and the real message stays in the server log (see catchError below).
    return INTERNAL_ERROR_MESSAGE;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        if (error instanceof HttpException) {
          return throwError(() => error);
        }

        const isError = error instanceof Error;
        const originalMessage = isError ? error.message : 'Internal server error';
        const originalStack = isError ? error.stack : undefined;

        this.logger.error(originalMessage, originalStack);

        const clientMessage = this.resolveClientMessage(error);
        const exception = new InternalServerErrorException(clientMessage);
        if (originalStack) exception.stack = originalStack;

        return throwError(() => exception);
      }),
    );
  }
}
