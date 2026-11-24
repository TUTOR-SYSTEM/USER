# Rule: Code conventions

- **Imports**: use the `@packages/*` alias for anything under `src/packages/`
  (e.g. `import { Public } from '@packages/decorators'`) — never long relative `../../..` paths.
- **Validation**: every request body/query is validated with a **Zod v4** schema via
  `new ZodValidationPipe<Dto>(schema)`. DTOs are `z.infer<>` types, never hand-written interfaces.
  Pagination query schemas use plain `z.coerce.number()` fields (`page`/`limit`), not `z.preprocess`.
- **Secrets**: never read, print, or edit `.env*` files (a PreToolUse hook blocks edits).
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
- **Request logging**: the global `LoggerInterceptor` (`@packages/interceptor`, wired in
  `main.ts`) logs `[Request]`/`[Response]`/`[Error]`/`[Timing]` lines including the request body
  and response data, redacting any key in its `SENSITIVE_KEYS` list (`password`, `token`,
  `accessToken`, `refreshToken`, etc.) and truncating logged JSON at 1000 chars. If a new field
  name carrying a secret is introduced (e.g. a new `*Secret`/`*Key` DTO field), add it to
  `SENSITIVE_KEYS` rather than relying on truncation to hide it.
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
- **Password-reset code is brute-force bounded across codes**: besides the 5 guesses per code, an account gets
  10 guesses per hour in total (`reset-password-otp-window:{userId}`, not reset by requesting a new code), and
  `forgotPassword` sends at most 3 codes per address per hour (counted for unknown addresses too). Both
  fail closed when Redis is unavailable.
- **Browser OAuth redirect never carries the refresh token**: access token in the URL fragment, refresh token
  in the httpOnly `refresh_token` cookie (`setRefreshCookie`), same as gateway.
- **"Current password" checks are throttled and gate email changes**: `UserService.assertCurrentPassword` counts
  wrong answers per account (5 per 15 min, `current-password-attempts:{userId}`, fails closed on Redis errors)
  and is used by `changePasswordService` and by self-update when the caller changes their OWN email (payload
  field `currentPassword`, never written to the row). Admin changing someone else's email is not asked, but
  `AdminService.updateManagedUser` still resets `emailVerified` and revokes sessions on an email change.
- **bcrypt cost** is 12 (`BCRYPT_ROUNDS`, clamped 10..15); `compareData` returns false on an unreadable hash
  (counts as a failed sign-in) and `hashData` never echoes its cause. Logs redact passwords, signatures and
  contact details (phone/address/dob) in both interceptors. Swagger `/api-docs` is off when
  `NODE_ENV=production` unless `SWAGGER_ENABLED=true`. List `search` is capped at 100 chars / 5 words.
- **Login lockout is per (client IP, account)**: `auth.login`/`auth.loginByUserCode` take `clientIp`
  from the gateway (`@Ip()`). The gateway signs it (`clientIpSig`, `splitClientIp`). An unsigned or
  forged IP is ignored and the shared bucket applies. The counter is keyed by IP and account, so one
  IP cannot lock the account for other IPs. A second counter per account (`LOGIN_ACCOUNT_MAX_ATTEMPTS`,
  default 20) is checked too, so distributed guessing of one account still hits a ceiling. That counter
  is not cleared on success.
- **Password change keeps the current device**: `UserService.changePasswordService(userId, dto, sid)`
  verifies the current password, revokes all sessions, then writes the new password, and finally
  re-creates only the caller's session (`sid`) with a new refresh token. Revoke comes before the
  password write on purpose: a Redis failure then leaves the password unchanged, never changed with
  old sessions still alive.
  Gateway moves that token into the httpOnly cookie and never returns it in the body.
- **Any password write revokes sessions**: every path that sets a password (self change, reset,
  admin/staff set) must call `revokeAllUserSessions(rmqProducer, userId)` after the write, so old
  access and refresh tokens stop working. `UserService.updateUserPasswordService` and
  `AdminService.setTutorPassword` / `StudentService.setPassword` are the reference.
- **Single-use Redis tokens use GETDEL**: one-time values (refresh hash on rotate, verify-email
  jti, reset-OTP) are read with `redis.getdel` (`redisGetAndDelete`), never `get` followed by a
  later `del`, so two concurrent requests cannot both consume them.
- **Session cache is per process**: `isSessionActive` caches positive answers for 1s;
  `revokeAllUserSessions` clears that process's cache, other processes lag at most that long.
- **Revocation markers beat in-flight refreshes**: every revoke writes `revoked-all:{uid}` or
  `revoked-session:{uid}:{sid}` (ms timestamp) before it deletes keys. `refreshTokens` writes the new
  session, then reads the markers. A marker at or after the refresh's start time undoes the write and
  rejects. Any new revoke path must write its marker before its deletes.
