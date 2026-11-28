# Rule: Code conventions

- **Imports**: use the `@packages/*` alias for anything under `src/packages/`
  (e.g. `import { Public } from '@packages/decorators'`) — never long relative `../../..` paths.
- **Validation**: every request body/query is validated with a **Zod v4** schema via
  `new ZodValidationPipe<Dto>(schema)`. DTOs are `z.infer<>` types, never hand-written interfaces.
  Pagination query schemas use plain `z.coerce.number()` fields (`page`/`limit`), not `z.preprocess`.
- **Secrets**: `.env*` files may be read and edited (no hook gate; user decision 2026-11-28). Never print secret values into chat or commit them.
  Reference config via `process.env` / `ConfigModule`.
- **Style**: single quotes, trailing commas, 100-char width, semicolons. Formatting/lint is
  auto-applied by a PostToolUse hook, so match surrounding code and let the hook normalize it.
- **Auth**: routes are guarded globally by `JwtAuthGuard`; add `@Public()` only for
  intentionally open endpoints, and `@Roles('ADMIN')` (from `@packages/decorators`, paired with
  `RolesGuard` from `@packages/guards`) for admin-only ones. `AdminRoleGuard` is also available
  in `@packages/guards`. Read the acting user with `@CurrentUser()` from `@packages/decorators`
  (returns the JWT payload; use `user.id`).
- **Helpers** (`@packages/helpers`): `checkUuidValid` / `generateCode` (from `generate.helper`),
  `hashData` / `compareData` (bcrypt from `hashingData.helper`), `buildListWhereClause` (for
  paginated list queries), `signAccessToken` / `signRefreshToken` (from `jwt.helper`),
  `splitRpcActor` (from `rpc-actor.helper`, verifies the gateway signature),
  `computeRpcActorSignature` / `verifyRpcActorSignature` (from `rpc-actor-signature.helper`).
- **Messages**: error strings in `ERROR_MESSAGES` (`src/data/constants`); success strings in
  `SUCCESS_MESSAGES` (same barrel). Never hardcode message text in services.
- **Swagger**: body/query schemas in `src/data/swaggers/data/{name}.swagger.ts`, response
  messages in `src/data/swaggers/messages/{name}.msg.ts`. Use `@ApiResponse()` decorator from
  `@packages/decorators` for success messages.
- **Request logging (removed 2026-11-28)**: the request/response logging interceptor, the `log-sink` pipeline and the `request_logs` writes were deleted. Do not add request logging back. Error responses still go through `ErrorInterceptor` and `HttpExceptionFilter`, and boot/error messages still use the Nest `Logger`. Correlation ids and `RequestContext` still propagate as described in the tracing bullet.
- **RPC pass/fail logging**: `RmqProducer.send`/`.emit` (`src/features/rabbitmq/rmq.producer.ts`)
  already log `[SEND-START]`/`[EMIT]` on dispatch and `[SEND-ATTEMPT-FAILED]`/`[SEND-FAILED]` on
  errors, each with the pattern + `correlationId`/`traceId` — this is built into the shared
  producer, so don't add ad-hoc logging around individual `send`/`emit` call sites.
- **Non-blocking side effects**: when an RPC call is for a side effect that must never fail the
  caller's main flow (best-effort cleanup, session/audit tracking), don't `await` it — fire the
  promise and attach `.catch((error) => this.logger.warn(...))` so a RabbitMQ/downstream hiccup is
  logged but never bubbles into the caller's response. See
  `AuthService.emitLoginSessionCreated`/the `redis.del` cleanup in `resetPasswordService`.
- **Acting-user RPC handlers take identity from the actor, not the payload**: an `@MessagePattern`
  that acts on "my own" account (`user.changePassword`, `auth.logout`) must compare the forwarded
  `actorId` (via `splitRpcActor`) with the payload `userId` and throw `ForbiddenException`
  (`ERROR_MESSAGES.FORBIDDEN_USER_ACTION`) on mismatch or empty actor. The gateway must forward
  `actorId` for these patterns or the call is refused.
- **RPC actor is signed by the gateway**: `splitRpcActor` only trusts `actorId`/`actorRole`/`actorSid`
  when `actorSig` (HMAC-SHA256 with `RPC_ACTOR_SECRET`) verifies and `actorSigTs` is within
  `RPC_ACTOR_MAX_AGE_MS` (300s). A second delivery of the same signature is refused by
  `RpcActorReplayInterceptor` (Redis `incr` per signature). Gateway re-signs on every send attempt,
  so its own retries are never refused. Otherwise the actor is empty and the handler returns 403. Gateway
  signs centrally in `RmqProducer.send`/`emit` (`withActorSignature`), so call sites only set
  `actorId`/`actorRole`(/`actorSid`). Keep `rpc-actor-signature.helper.ts` identical in both repos.
  Tests that send actors must sign them (see `test/features/user/user.rpc.controller.spec.ts`).
- **OAuth profiles are signed by the gateway**: `auth.googleLogin`/`auth.facebookLogin` accept a profile
  only when `oauthProfileSig` (HMAC with `RPC_ACTOR_SECRET`, bound to provider + provider id + email +
  timestamp) verifies (`splitOAuthProfile`); otherwise 403. The signature is single-use
  (`RpcActorReplayInterceptor`). Gateway signs centrally in `withActorSignature`; keep
  `rpc-actor-signature.helper.ts` identical in both repos. Every `auth.*` RPC payload is validated with the
  same Zod schema as its HTTP route (`parseRpcPayload`), never trusted as-is.
- **bcrypt byte cap (F-16, 2026-11-28)**: bcrypt reads only the first 72 UTF-8 bytes. Every write-side password schema must cap bytes too, not just characters: `newPasswordSchema` (`password.schema.ts`, `BCRYPT_MAX_BYTES`) and `studentPasswordSchema` (`student.schema.ts`). Login keeps 100 characters with no byte check because it only compares. Add the same byte check to any new password schema.
- **Password-reset code is brute-force bounded per address**: every reset guess is counted against the
  address (hashed email), whether or not the account exists or has a code: 5 guesses per code lifetime
  (`reset-password-email-attempts:`, 5 min) and 10 per hour (`reset-password-email-window:`), so a registered and
  an unknown address answer the same at the limit. Per-code and per-account counters still apply. Requesting a new
  code does not reset the address counters. `forgotPassword` sends at most 3 codes per address per hour (counted for
  unknown addresses too; over quota is a 429 for everyone), skips deactivated accounts and placeholder addresses, and
  fails closed (503). A code is put back when the password was not changed by an infrastructure failure.
- **Browser OAuth redirect never carries the refresh token**: access token in the URL fragment, refresh token
  in the httpOnly `refresh_token` cookie (`setRefreshCookie`), same as gateway.
- **"Current password" checks are throttled and gate email changes**: `UserService.assertCurrentPassword` counts
  wrong answers per account (5 per 15 min, `current-password-attempts:{userId}`, fails closed on Redis errors)
  and is used by `changePasswordService` and by self-update when the caller changes their OWN email (payload
  field `currentPassword`, never written to the row). Admin changing someone else's email is not asked, but
  `AdminService.updateManagedUser` still resets `emailVerified` and revokes sessions on an email change. The self-update path (`UserService.applyUserUpdate`) does the same: a changed email revokes all sessions, as do a role change or deactivation.
- **bcrypt cost** is 12 (`BCRYPT_ROUNDS`, clamped 10..15); `compareData` returns false on an unreadable hash
  (counts as a failed sign-in) and `hashData` never echoes its cause. Logs redact passwords, signatures and
  contact details (phone/address/dob) in both interceptors. Swagger `/api-docs` is off when
  `NODE_ENV=production` unless `SWAGGER_ENABLED=true`. List `search` is capped at 100 chars / 5 words.
- **Login lockout is per (client IP, account)**: `auth.login`/`auth.loginByUserCode` take `clientIp`
  from the gateway (`@Ip()`). The gateway signs it (`clientIpSig`, `splitClientIp`). An unsigned or
  forged IP is ignored and the shared bucket applies. The counter is keyed by IP and account, so one
  IP cannot lock the account for other IPs. A second counter per account (`LOGIN_ACCOUNT_MAX_ATTEMPTS`,
  default 20) is checked too, so distributed guessing of one account still hits a ceiling. That counter
  is not cleared on success. **Attempts are counted before the password is checked** (`reserveLoginAttempt`,
  atomic `redis.incr`): every attempt takes a slot, successful ones included, so parallel guesses cannot all
  pass a check that the others have not incremented. The IP counter is cleared on success; the account counter
  is a rate limit per window (20 sign-ins per account per 15 min by default).
- **Password change keeps the current device**: `UserService.changePasswordService(userId, dto, sid)`
  verifies the current password, revokes all sessions, then writes the new password, and finally
  re-creates only the caller's session (`sid`) with a new refresh token. Revoke comes before the
  password write on purpose: a Redis failure then leaves the password unchanged, never changed with
  old sessions still alive.
  Gateway moves that token into the httpOnly cookie and never returns it in the body.
- **Generated passwords**: `generateRandomPassword()` (`@packages/helpers`) returns 10 chars by default,
  always with a lowercase, uppercase, digit and one of `!@#$%^&*`, no look-alikes (`l I O 0 1`), CSPRNG
  (`randomInt` + Fisher–Yates). It satisfies `newPasswordSchema` and `managedPasswordSchema` (8–20), so keep it
  inside those limits if the policy changes. It used to be 32-char base64url: don't assert that shape in tests.
- **Any password write revokes sessions**: every path that sets a password (self change, reset,
  admin/staff set) must call `revokeAllUserSessions(rmqProducer, userId)` after the write, so old
  access and refresh tokens stop working. `UserService.updateUserPasswordService` and
  `AdminService.setTutorPassword` / `StudentService.setPassword` are the reference.
- **Single-use Redis tokens use GETDEL**: one-time values (refresh hash on rotate, verify-email
  jti, reset-OTP) are read with `redis.getdel` (`redisGetAndDelete`), never `get` followed by a
  later `del`, so two concurrent requests cannot both consume them. **Exception (refresh only):** if the
  rotation fails for an infrastructure reason before the new pair is stored, `refreshTokens` writes the consumed
  hash back (`restoreRefreshHash`), so a transient Redis/RabbitMQ error does not sign the client out. It never
  restores after a revoke or a closed session, and the restore is best effort.
- **Session cache is per process**: `isSessionActive` caches positive answers for 1s;
  `revokeAllUserSessions` clears that process's cache, other processes lag at most that long.
- **Revocation markers beat in-flight refreshes**: every revoke writes `revoked-all:{uid}` or
  `revoked-session:{uid}:{sid}` (ms timestamp) before it deletes keys. `refreshTokens` writes the new
  session, then reads the markers. A marker at or after the refresh's start time undoes the write and
  rejects. Any new revoke path must write its marker before its deletes. The deletes go through awaited `rmqProducer.send('redis.del', …)`, never `emit`: `emit` resolves on publish, so a logout could report success while the session key survives.
- **Lockout counters fail closed**: `reserveLoginAttempt` (via `incrLoginCounter`) throws 503 (`SESSION_CHECK_UNAVAILABLE`) when the counter is unreachable or its reply is not a number, so a right and a wrong password answer the same during an outage.
- **Guard checks role against the DB**: `JwtAuthGuard` selects `role` with `isActive` and rejects a token whose role differs from the row, so a demotion bites at once even if revoke failed.
- **Facebook email is not proof**: `findOrCreateOAuthUser(profile, { emailProven: false })` refuses to link an existing account and creates new ones with `emailVerified=false`. Only Google (which sends `email_verified`) may link by email.
- **New passwords are capped at 72 bytes** (bcrypt reads no more); the login schema keeps 100 chars so old accounts can still sign in. In production the boot fails when `RPC_ACTOR_SECRET` is under 32 chars or Google OAuth credentials are missing.
- **TUTOR `user.createUser` drops `parentId`**: parents are attached through the student surface, which applies the `findParentForActor` sharing policy.
- **Session store and revoke failures are 503, never raw**: `issueTokens` and `revokeSession` wrap their awaited
  Redis/RMQ calls and rethrow `ServiceUnavailableException(SESSION_CHECK_UNAVAILABLE)`. A transport error
  (which can carry the broker URL) must never reach the client as a message.
- **Translated messages with a number**: a `CODE: value` message is localized by `translateMessage`. If the dictionary
  text contains `{}`, the value goes there (for example `TOO_MANY_LOGIN_ATTEMPTS_WAIT`, "…try again in {} minutes");
  otherwise the value is appended after `: `.
- **Auth RPC payloads are Zod-parsed, including `auth.logout`** (`logoutSchema`), after the actor check.
- **Log redaction covers identity fields** (`email`, names, `userCode`, provider ids) in both interceptors.
- **`mustChangePassword` is enforced server-side**: `JwtAuthGuard` refuses every HTTP route for such an account unless the handler has `@AllowWhileMustChangePassword()` (only `changePassword`); `RpcMustChangePasswordInterceptor` does the same for acting RPCs except `user.changePassword` and `auth.logout`. New self-service routes a flagged user needs must carry the decorator.
- **Unknown errors reach clients as `Internal server error`** (`ErrorInterceptor`): known DB codes and ORM text keep their mapped messages, the real message is only logged.
- **Sign-in failures name the cause (2026-11-28)**: `loginService` answers an unknown email with
  `EMAIL_NOT_REGISTERED` (401), a wrong password (and an OAuth-only account) with `INVALID_PASSWORD` (401), and
  `loginByUserCodeService` an unknown code or role with `USER_CODE_NOT_FOUND`. This lets a caller learn which emails
  have accounts, a trade-off the owner chose. Lockout (429), disabled accounts (401 `ACCOUNT_DEACTIVATED`) and the
  Redis-unavailable 503 are unchanged. Registration still answers a registered email like a new sign-up (F-09).
  Google/Facebook callbacks keep the generic `INVALID_CREDENTIALS`.
- **Registering a taken email answers like a new sign-up (F-09)**: `AuthService.registerService` checks the
  username first (a taken username is a 400 `AUTH_USERNAME_TAKEN` for every address, so it never reveals the email).
  Then it checks the email; if it is registered, `registerDecoy` runs a bcrypt hash, sends the owner a notice through
  `email.sendAccountExists` (best-effort), and returns the same 201 shape with a random id and the same username
  generator as a real sign-up. It writes nothing to the DB. A concurrent insert that loses on the email is re-checked and
  gets the same decoy. Keep new public sign-up paths on this behaviour.
- **Verification mail can be re-sent**: `auth.resendVerifyEmail` (`POST /auth/resendVerifyEmail`, public) sends the mail
  only to an unverified, active account with a real address, and is limited to 3 per address per hour.
- **Actor signature is bound to pattern and payload**: gateway adds `actorBind` (HMAC over `pattern`, `hashRpcPayload(payload)`, `actorSig`, `actorSigTs`) in `withActorSignature(message, pattern)`; `RpcActorBindingInterceptor` (first in `main.ts`, before the replay guard) answers 403 when it is missing or does not match. The payload hash skips the signature fields, uses sorted keys and ignores `undefined`. Keep `rpc-actor-signature.helper.ts` identical in both repos, and deploy both together. New acting RPCs need nothing extra: the producer binds every signed actor.
- **`student.generateCode` needs a signed ADMIN/TUTOR actor** like the other acting RPCs; gateway forwards `actorId`/`actorRole`.
