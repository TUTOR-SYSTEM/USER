# Báo cáo review tĩnh: USER (identity/admin service)

- **Ngày**: 2026-11-27
- **Repo**: `/home/user/USER` (NestJS 11, Prisma 7, RabbitMQ)
- **Commit đang xem**: `ddcfd3d`
- **Phạm vi**: auth, user, admin, student, module rabbitmq, helpers, guards, interceptors, filters, `main.ts`, `app.controller.ts`, Dockerfile / docker-compose / CI. Đối chiếu `gateway` chỉ ở route guard.
- **Không đọc** `.env*` và secret. `.env.compose` chỉ kiểm tra tên qua `git ls-files`.
- **Trạng thái**: review tĩnh (đọc code). Chưa chạy tsc, lint, test hay build vì repo không có `node_modules/` và `src/generated/prisma`.

## 1. Tóm tắt

Tổng finding: **Critical 0, High 0, Medium 6, Low 11, Info 4** (tổng 21).

Không có finding Critical/High được xác nhận. Năm rủi ro quan trọng nhất:

1. **F-01 (Medium)**: login lockout fail-open khi Redis lỗi. Đúng/sai mật khẩu trả phản hồi khác nhau, tạo oracle đoán mật khẩu.
2. **F-02 (Medium)**: chữ ký RPC actor không bao payload và pattern. Bên có quyền consume `user_queue` có thể đổi target của envelope đã ký.
3. **F-03 (Medium, latent)**: nhánh TUTOR của `user.createUser` gắn `parentId` bất kỳ, bỏ qua chính sách parent-sharing. Gateway chỉ cho ADMIN gọi HTTP nên hiện chưa khai thác được qua public API.
4. **F-05 (Medium, cần xác minh)**: Facebook login không kiểm tra email đã xác minh (Google thì có). Có thể đăng nhập vào STUDENT đã xác minh cùng email.
5. **F-06 (Medium)**: mật khẩu Postgres và `admin/admin` RabbitMQ hardcode trong `docker-compose.yml`; `.env.compose` được git track.

## 2. Bảng tổng hợp

| ID | Mức độ | Loại | File:line | Tiêu đề |
|----|--------|------|-----------|---------|
| F-01 | Medium | Security | `src/features/auth/auth.service.ts:207-239`, `264-281` | Lockout fail-open khi Redis lỗi; oracle mật khẩu |
| F-02 | Medium | Security | `src/packages/helpers/rpc-actor-signature.helper.ts:23-27`; `src/packages/helpers/rpc-actor.helper.ts:32-49`; `src/features/rabbitmq/rpc-actor-replay.interceptor.ts:33-40` | Chữ ký actor không bao payload và pattern |
| F-03 | Medium | Security (latent) | `src/features/user/user.service.ts:274-289`, `681-691` | TUTOR qua `user.createUser` gắn `parentId` bất kỳ |
| F-04 | Medium | Bug | `src/features/auth/auth.controller.ts:346-348` | Facebook callback đọc `GOOGLE_OAUTH_REDIRECT_URL` |
| F-05 | Medium | Security (cần xác minh) | `src/packages/strategy/facebook.strategy.ts:30-44`; `src/features/auth/auth.service.ts:429-448` | Facebook không kiểm tra email đã xác minh |
| F-06 | Medium | Security | `docker-compose.yml:32`, `:45`; `.env.compose` (git-tracked) | Credential hardcode; file env được track |
| F-07 | Low | Bug / Security | `src/features/auth/auth.service.ts:380-390` (dòng 387) | Revoke một session dùng `emit`, trái comment "awaited" |
| F-08 | Low | Security | `src/packages/interceptor/trace-context.interceptor.ts:22-52`, `179-209` | Log RPC lưu email và họ tên vào `request_logs` |
| F-09 | Low | Security | `auth.service.ts:322`, `326`, `475`, `548`, `642-644`; `student.service.ts:229` | Lộ sự tồn tại tài khoản (message và timing) |
| F-10 | Low | Security / Bug | `src/features/user/user.service.ts:421-434`, `664-672` | Admin tự vô hiệu hoá/hạ quyền mình; TOCTOU admin cuối |
| F-11 | Low | Security | `src/features/user/user.service.ts:741-748` | Đổi email của chính mình không revoke session |
| F-12 | Low | Security | `src/packages/guards/jwt-auth.guard.ts:108-127`; `auth.service.ts:366` | `mustChangePassword` chỉ là cờ phía client |
| F-13 | Low | Security | `src/packages/guards/jwt-auth.guard.ts:61`, `108-127`; `user.service.ts:748` | Role lấy từ JWT, không đối chiếu DB; revoke sau khi ghi |
| F-14 | Low | Security | `src/app.controller.ts:35-58`, `115-149`; `src/features/student/student.rpc.controller.ts:26-28` | RPC debug/thống kê và `student.generateCode` không kiểm tra actor |
| F-15 | Low | Bug | `src/features/student/student.service.ts:606-646` | Update học sinh không atomic |
| F-16 | Low | Security | `src/packages/entities/auth/password.schema.ts:6`; `src/packages/helpers/hashingData.helper.ts:19` | Mật khẩu tới 100 ký tự nhưng bcrypt chỉ dùng 72 byte |
| F-17 | Low | Security | `src/packages/interceptor/error.interceptor.ts:16-40` | Message non-HTTP error trả nguyên văn cho client |
| F-18 | Info | Bug | `src/features/user/user.service.ts:628` | Đếm attempt fail open nếu `redis.incr` trả rỗng |
| F-19 | Info | Security | `src/packages/strategy/google.strategy.ts:18-21` | Fallback clientID/secret chuỗi giả |
| F-20 | Info | Security | `src/main.ts:25-32` | `RPC_ACTOR_SECRET` ngắn chỉ cảnh báo |
| F-21 | Info | Security | `src/packages/guards/jwt-auth.guard.ts:101-103` | `jwt.verify` không khai báo `algorithms` |

## 3. Chi tiết

**F-01 (Medium, Security): lockout fail-open khi Redis lỗi.** `assertLoginNotLocked` (`auth.service.ts:207-239`, `return` tại dòng 228) bỏ qua khoá khi `redis.get` lỗi. `recordLoginFailure` (`264-281`) nuốt lỗi khi `redis.incr` lỗi. Mật khẩu vẫn được kiểm bằng bcrypt. Nếu đúng, `issueTokens` (`347-356`) phải ghi session vào Redis nên ném 5xx/504 sau timeout; nếu sai thì trả 401 ngay. Tác động: trong lúc Redis lỗi không có giới hạn đoán mật khẩu, và kẻ tấn công phân biệt được mật khẩu đúng qua mã trạng thái và thời gian. Tái hiện: làm `third_queue` không phản hồi, gửi nhiều `POST /auth/login`, so sánh 401 với 5xx/504. Đề xuất: login fail closed (503) khi không đọc được lockout; `recordLoginFailure` cũng fail closed.

**F-02 (Medium, Security): chữ ký actor không bao payload.** `computeRpcActorSignature` (`rpc-actor-signature.helper.ts:23-27`) chỉ băm `actorId|actorRole|actorSid|actorSigTs`. `splitRpcActor` (`rpc-actor.helper.ts:32-49`) trả phần `rest` chưa ký. Ví dụ `admin.deleteStudent` ký actor ADMIN nhưng không ký `id`. Chữ ký cũng hợp lệ với mọi pattern nếu actor trùng. Replay guard (`rpc-actor-replay.interceptor.ts:33-40`, `57-59`) coi lần dùng đầu là hợp lệ. Tác động: bên có quyền consume `user_queue` có thể lấy envelope đã ký, đổi `id` và gửi lại trước bản gốc. Mức Medium vì cần quyền broker. Đề xuất: ký hash canonical của payload cùng pattern và timestamp; đồng bộ helper với gateway.

**F-03 (Medium, Security, latent): TUTOR gắn PARENT tuỳ ý.** `createUserByActorService` nhánh TUTOR (`user.service.ts:280-287`) ép `role`/`tutorId` nhưng giữ `parentId`; `assertLinkTarget` (`681-691`) chỉ kiểm tra role PARENT. Chính sách repo (`student.repository.ts:197-207` `findParentForActor`) yêu cầu PARENT do tutor tạo hoặc có con thuộc tutor. Gateway (`gateway/src/features/user/user.controller.ts:142-144`) chỉ cho ADMIN gọi `POST /users`. Đề xuất: dùng `findParentForActor` trong nhánh TUTOR, hoặc bỏ nhánh TUTOR.

**F-04 (Medium, Bug): Facebook callback dùng biến Google.** `facebookAuthCallback` (`auth.controller.ts:346-348`) đọc `GOOGLE_OAUTH_REDIRECT_URL`. Login Facebook redirect sai khi hai URL khác nhau. Không phải lỗ hổng trực tiếp vì giá trị lấy từ env. Đề xuất: đọc biến riêng cho Facebook.

**F-05 (Medium, Security, cần xác minh): Facebook không kiểm tra email đã xác minh.** `facebook.strategy.ts:30-44` chỉ kiểm tra có email. `google.strategy.ts:30-40` bắt `email_verified === true`. `findOrCreateOAuthUser` (`auth.service.ts:429-448`) trả về STUDENT cùng email đã xác minh, không cần mật khẩu. Nếu Facebook trả email chưa xác minh, kẻ tấn công tạo tài khoản FB với email nạn nhân và nhận token. Nâng lên High nếu xác minh được. Đề xuất: liên kết theo `facebookId`, hoặc chỉ dùng email khi provider xác nhận. Cần xác minh: tài liệu Facebook về trường `email`.

**F-06 (Medium, Security): credential hardcode.** `docker-compose.yml:32` chứa mật khẩu Postgres (không chép vào báo cáo). `docker-compose.yml:45` đặt RabbitMQ `admin/admin`. `git ls-files` cho thấy `.env.compose` được track; nội dung không đọc. Đề xuất: đưa về biến môi trường, xoay secret đã lộ, untrack `.env.compose` nếu có secret, kiểm tra lịch sử git.

**F-07 (Low): revoke một session dùng `emit`.** `revokeSession` (`auth.service.ts:380-390`, dòng 387) `await emit('redis.del')`. `emit` resolve khi publish, không chờ xoá. Comment dòng 379 không đúng. Logout có thể báo thành công trong khi `session:{uid}:{sid}` còn; `JwtAuthGuard` kiểm tra đúng key đó nên access token còn dùng được tới 3 giờ. Đề xuất: dùng `send` có retry và coi lỗi là 503.

**F-08 (Low, Security): PII trong `request_logs`.** `SENSITIVE_KEYS` (`trace-context.interceptor.ts:22-52`, và `logger.interceptor.ts:5-36`) không có `email`, `firstName`, `lastName`, `parentEmail`, `userCode`, `googleId`. `emitRequestLog` (`179-209`) gửi body/response RPC inbound sang third-service. Đề xuất: thêm khoá PII hoặc bỏ body cho pattern có PII.

**F-09 (Low, Security): enumeration.** `auth.service.ts:322` (`EMAIL_NOT_FOUND`) và `326` (`INVALID_PASSWORD`) cho phép liệt kê email qua login. `548` (`USER_CODE_NOT_FOUND`), `475` (đăng ký trùng). `642-644`: reset trả sớm khi email không tồn tại, không gọi Redis, timing khác. `student.service.ts:229`: `dto.email` không kiểm tra trước, lộ qua P2002. Đề xuất: thông báo thống nhất; luôn gọi Redis trong reset.

**F-10 (Low, Security/Bug): admin tự hạ quyền mình.** `updateUserService` (`user.service.ts:421-434`) không chặn `actor.id === id`. `updateStatusUserService` (`506-508`) có chặn `CANNOT_MODIFY_OWN_STATUS`. `assertNotLastActiveAdmin` (`664-672`) đếm rồi ghi, không transaction: hai admin hạ nhau cùng lúc có thể làm hệ thống mất hết admin. Đề xuất: chặn tự sửa role/isActive; khoá khi đếm.

**F-11 (Low, Security): đổi email không revoke session.** `applyUserUpdate` (`user.service.ts:741-748`) chỉ đặt `emailVerified: false`; revoke chỉ khi demote hoặc deactivate. Admin path (`admin.service.ts:335`) có revoke. Đề xuất: revoke khi `emailChanged`.

**F-12 (Low, Security): `mustChangePassword` không được thực thi phía server.** `JwtAuthGuard` (`108-127`) không kiểm tra cờ; `auth.service.ts:366` chỉ trả trong response. Tài khoản tạm thời vẫn dùng được mọi API. Đề xuất: chặn route ngoài `changePassword`/`logout` khi cờ bật (guard đã có `findUnique` tại `118-121`).

**F-13 (Low, Security): role lấy từ JWT.** `jwt-auth.guard.ts:61` lấy role từ token, `108-127` chỉ kiểm tra `isActive`. Đổi role có revoke (`user.service.ts:748`) nhưng revoke chạy sau khi ghi; nếu revoke lỗi, token cũ giữ quyền ADMIN tới 3 giờ. Đề xuất: so role với DB trong guard, hoặc revoke trước khi ghi.

**F-14 (Low, Security): RPC không xác thực actor.** `app.controller.ts:35-58` (`kafka.*`, `kafka.user` chuyển tiếp payload tuỳ ý sang `kafka.tutor`), `115-149` (`health.postgres` trả số user theo role). `student.rpc.controller.ts:26-28` (`student.generateCode`). Đề xuất: xoá handler `kafka.*` cũ; giới hạn health; thêm actor cho `generateCode`.

**F-15 (Low, Bug): update học sinh không atomic.** `student.service.ts:606-608` ghi student, `614` relink, `644` `linkOrCreateParent` có thể lỗi sau khi đã ghi. Đề xuất: transaction.

**F-16 (Low, Security): bcrypt 72 byte.** `password.schema.ts:6` cho 100 ký tự, `hashingData.helper.ts:19` dùng `bcrypt.hash`. Hai mật khẩu chung 72 byte đầu bị coi là giống nhau. Đề xuất: giới hạn 72 byte hoặc băm SHA-256 trước.

**F-17 (Low, Security): message lỗi nội bộ.** `error.interceptor.ts:16-40` trả `error.message` nguyên văn cho lỗi không khớp mã đã biết. Đề xuất: "Internal server error" và chỉ log message thật (như `RpcExceptionFilter`).

**F-18 (Info):** `user.service.ts:628` `reply?.count ?? 0` fail open nếu reply rỗng. Đề xuất: coi là 503.

**F-19 (Info):** `google.strategy.ts:18-21` fallback chuỗi giả khi thiếu env. Đề xuất: throw như `getJwtTokensConfig`.

**F-20 (Info):** `main.ts:25-32` `RPC_ACTOR_SECRET` dưới 32 ký tự chỉ warn. Đề xuất: từ chối khởi động.

**F-21 (Info):** `jwt-auth.guard.ts:101-103` `verify` không có `algorithms`. Hiện chưa khai thác được. Đề xuất: khai báo `HS256`.

## 4. Đã kiểm tra và thấy ổn

- Xác thực RPC actor: HMAC-SHA256 với `timingSafeEqual`, cửa sổ 300 giây, fail closed; replay guard fail closed.
- `auth.logout` và `user.changePassword` so actor với `userId`, chặn actor rỗng; `user.getDetailUser`, `student.*`, `admin.*` dựa trên actor đã xác minh.
- JWT: không có secret mặc định; access token bắt buộc `sid`; session kiểm tra trong Redis, fail closed mặc định. Refresh token băm trước khi lưu, so sánh constant-time, có phát hiện reuse.
- Revoke: marker ghi trước khi xoá; refresh đang bay bị chặn. Đổi mật khẩu revoke trước khi ghi.
- Reset OTP: lưu hash có salt; đếm lần thử theo mã (5) và theo tài khoản (10/giờ); GETDEL; giới hạn gửi mã theo địa chỉ.
- OAuth: kiểm tra `state` bằng cookie HttpOnly và `timingSafeEqual`; profile từ gateway được ký và single-use; social login không cấp cho ADMIN/TUTOR/PARENT.
- Refresh cookie: HttpOnly, `secure` ở production, path `/auth`.
- Truy vấn: Prisma tham số hoá; `$queryRaw` dùng tagged template và `Prisma.join`; không có `$queryRawUnsafe`; `findByField` có whitelist.
- Mass assignment: schema `.strict()`; `sanitizeUpdate` loại `id`, `password`, `emailVerified`, `currentPassword`; self-update chặn `role`, `isActive`, `parentId`, `tutorId`, `googleId`, `facebookId`, `userCode`.
- Parent: `findParentForActor` chặn TUTOR gắn PARENT ngoài phạm vi trong `student.create`/`update`; TUTOR không sửa được PARENT đã có (`student.service.ts:551-554`).
- Mật khẩu và mã: `crypto.randomInt`; bcrypt cost 12 (clamp 10-15); `compareData` trả false khi hash lỗi; redaction che password, otp, token, signature, số điện thoại, địa chỉ.
- Lỗi RPC: `RpcExceptionFilter` không lộ message nội bộ; `HttpExceptionFilter` không lộ stack ngoài development.
- CORS không wildcard; Swagger tắt ở production; Dockerfile chạy user `node`, không đưa secret vào image.
- Gateway: `GET/PUT/DELETE` student và user có `RolesGuard` đúng vai trò đã đối chiếu.

## 5. Hạn chế

- Không chạy được tsc, lint, test hay build: không có `node_modules/` và `src/generated/prisma`. Mọi finding là đọc code, chưa chạy thực tế.
- Chưa đọc đầy đủ: phần list/paginate của `student.repository.ts` và `admin.repository.ts`; phần lớn `user.repository.ts`; helper `queryList`, `username`, `checkEnv`, `file`, `decorators`; `i18n`, `docs/`, `scripts/`, `test/`.
- Không đọc `.env*`, nên không kiểm tra cấu hình thật (`CORS_ALLOWED_ORIGINS`, `RPC_ACTOR_SECRET`, `SESSION_CHECK_FAIL_OPEN`, `LOGIN_*`).
- Hành vi của third-service (`redis.incr` trả `{count}`, `redis.delByPrefix`, `redis.getdel`, không ghi body `email.*`) suy ra từ code gọi và CLAUDE.md, chưa đọc code third-service.
- Cần xác minh: F-01 (mô phỏng outage Redis), F-02 (khả năng consume `user_queue`), F-05 (tài liệu Facebook), F-06 (nội dung `.env.compose`, lịch sử git).
- Không đánh giá: mạng/TLS, cấu hình RabbitMQ/Postgres trên Railway, rate limit của gateway, mức phơi nhiễm thực tế của cổng HTTP.

## 6. Trạng thái fix (đã test lại)

Kiểm tra lần cuối (2026-11-27): `user`: `tsc --noEmit` pass, `jest` 845/846 pass (còn fail `createUserSchema › requires email, firstName, lastName and password`, có sẵn từ trước). `gateway`: `tsc --noEmit` pass, `jest` 525/528 pass; 3 test fail là lỗi có sẵn trước khi sửa (`student update` ADMIN-only trong `student.authz`, `route-guards`, `user.role-guard`). Đã đồng bộ `.claude/rules/conventions.md`.

### Đã fix
- [x] **F-01**: lockout fail closed (503) khi Redis lỗi, cả đọc lẫn ghi counter (`auth.service.ts`).
- [x] **F-02**: `actorBind` (HMAC trên pattern + hash payload + `actorSig`) do `gateway` ký trong `withActorSignature(message, pattern)`; user kiểm tra bằng `RpcActorBindingInterceptor` chạy trước replay guard, thiếu hoặc sai thì 403. Helper `rpc-actor-signature.helper.ts` vẫn giống hệt ở hai repo. **Triển khai `gateway` và `user` cùng lúc**, bản cũ không gửi `actorBind` sẽ bị từ chối.
- [x] **F-03**: nhánh TUTOR của `user.createUser` bỏ `parentId` (`user.service.ts`).
- [x] **F-04**: Facebook callback đọc `FACEBOOK_OAUTH_REDIRECT_URL`, fallback biến Google.
- [x] **F-05**: Facebook không còn liên kết tài khoản có sẵn theo email; tài khoản mới tạo với `emailVerified=false`.
- [x] **F-07**: `revokeSession` dùng `send` thay `emit`.
- [x] **F-08**: thêm `email`, tên, `userCode`, `googleId`, `facebookId` vào danh sách redact của cả hai interceptor.
- [x] **F-09**: login và đăng nhập bằng mã người dùng trả cùng `INVALID_CREDENTIALS` (kể cả tài khoản không có mật khẩu); reset với email lạ vẫn đọc Redis như tài khoản thật; tạo học sinh trùng email trả lỗi chung trước khi insert. Còn lại: đăng ký trùng email vẫn 400 (cùng message với trùng username); ẩn hoàn toàn cần luồng "đã gửi mail" giả.
- [x] **F-10**: admin không tự hạ quyền hoặc vô hiệu hoá chính mình.
- [x] **F-11**: đổi email revoke toàn bộ session.
- [x] **F-12**: `JwtAuthGuard` chặn mọi route khi `mustChangePassword`, trừ route có `@AllowWhileMustChangePassword()` (changePassword); RPC có `RpcMustChangePasswordInterceptor` chỉ cho `user.changePassword` và `auth.logout`.
- [x] **F-13**: `JwtAuthGuard` so role trong token với DB.
- [x] **F-14**: bỏ handler `kafka.user` (forward payload tuỳ ý sang tutor) và route debug tương ứng ở `gateway`; `student.generateCode` yêu cầu actor ADMIN/TUTOR có chữ ký, `gateway` đã gửi actor. Các handler `kafka.*` còn lại chỉ log/echo, `health.postgres` giữ nguyên.
- [x] **F-15**: `StudentService.update` kiểm tra và hash trước, rồi ghi một transaction (`StudentRepository.applyStudentUpdate`): student, parent cũ, parent mới và link. Mail tài khoản và revoke session chạy sau commit.
- [x] **F-16**: mật khẩu mới tối đa 72 byte (`newPasswordSchema`); login giữ 100 ký tự.
- [x] **F-17**: `ErrorInterceptor` trả `Internal server error` cho lỗi không xác định; giữ mapping mã DB và `Database error` cho lỗi ORM.
- [x] **F-18**: đếm attempt đổi mật khẩu fail closed khi `redis.incr` trả rỗng.
- [x] **F-19**: thiếu `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` ở production thì từ chối khởi động.
- [x] **F-20**: `RPC_ACTOR_SECRET` dưới 32 ký tự ở production thì từ chối khởi động.
- [x] **F-21**: `jwt.verify` khai báo `algorithms: ['HS256']`.

### Chưa fix
- [ ] **F-06**: phần code đã xong (`docker-compose.yml` đọc `POSTGRES_*`/`RABBITMQ_DEFAULT_*` từ biến môi trường, `.env.compose*` đã bị xoá khỏi working tree). Còn lại việc của bạn: xoay mật khẩu Postgres và RabbitMQ đã nằm trong git history, tạo `.env` cho compose, và commit việc xoá `.env.compose*`.
