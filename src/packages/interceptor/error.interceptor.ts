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
    const message = error instanceof Error ? error.message : 'Internal server error';
    // ORM errors embed the failed query / invocation text — never echo that to clients.
    return message.startsWith('Failed query:') || message.includes('Invalid `prisma.')
      ? 'Database error'
      : message;
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
