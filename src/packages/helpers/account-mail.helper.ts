import { Logger } from '@nestjs/common';

/** Minimal slice of `RmqProducer` this helper needs (keeps packages free of feature imports). */
export interface AccountMailClient {
  send<TResponse, TRequest>(
    pattern: string,
    message: TRequest,
    timeoutMs?: number,
    maxRetries?: number,
  ): Promise<TResponse>;
}

export interface AccountCreatedMailInput {
  userId: string;
  email: string;
  username: string;
  displayName: string;
  /** Plaintext password of the new account. Sent to the mail service only; never logged. */
  password: string;
}

/** Placeholder address given to accounts created without an email. Nothing is mailed to it. */
const PLACEHOLDER_EMAIL_SUFFIX = '@no-email.local';

const logger = new Logger('AccountMail');

/**
 * Mails the login credentials of an account just created by an admin/tutor. Best-effort: the
 * account already exists, so any RMQ/mail failure (or timeout) is only logged as an error name and
 * never fails the create. Skips placeholder addresses.
 */
export async function sendAccountCreatedMail(
  client: AccountMailClient,
  input: AccountCreatedMailInput,
): Promise<void> {
  if (!input.email || input.email.endsWith(PLACEHOLDER_EMAIL_SUFFIX)) return;
  try {
    await client.send<unknown, Record<string, string>>('email.sendAccountCreated', {
      to: input.email,
      email: input.email,
      username: input.username,
      password: input.password,
      displayName: input.displayName,
    });
  } catch (error: unknown) {
    const name = error instanceof Error ? error.name : 'UnknownError';
    logger.warn(`Failed to send account-created email to user ${input.userId} (${name})`);
  }
}
