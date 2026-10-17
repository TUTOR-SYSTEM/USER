import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap, finalize } from 'rxjs';

const SENSITIVE_KEYS = [
  'password',
  'newPassword',
  'oldPassword',
  'confirmPassword',
  'token',
  'accessToken',
  'refreshToken',
  // One-time credentials carried in reset/verify links and in the RPC bodies that handle them.
  'jti',
  'resetToken',
  'verifyToken',
];
const MAX_LOG_LENGTH = 1000;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, val]) => [
        key,
        SENSITIVE_KEYS.includes(key) ? '[REDACTED]' : redact(val),
      ]),
    );
  }
  return value;
}

function stringifyForLog(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(redact(value));
  } catch {
    return '[Unserializable]';
  }
  if (json === undefined) return 'undefined';
  return json.length > MAX_LOG_LENGTH ? `${json.slice(0, MAX_LOG_LENGTH)}…(truncated)` : json;
}

@Injectable()
export class LoggerInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LoggerInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const { method, url } = request;
    const body: unknown = request.body;
    const startTime = Date.now();

    if (body && typeof body === 'object' && Object.keys(body).length > 0) {
      this.logger.log(`[Request] ${method} ${url} - body=${stringifyForLog(body)}`);
    }

    return next.handle().pipe(
      tap({
        next: (data) => {
          this.logger.log(
            `[Response] ${method} ${url} - ${response.statusCode} - data=${stringifyForLog(data)}`,
          );
        },
        error: (err) => {
          this.logger.error(`[Error] ${method} ${url} - ${(err as Error).message}`);
        },
      }),

      finalize(() => {
        const duration = Date.now() - startTime;
        this.logger.log(`[Timing] ${method} ${url} - ${duration}ms`);
      }),
    );
  }
}
