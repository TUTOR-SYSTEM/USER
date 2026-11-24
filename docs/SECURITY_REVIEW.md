# Security & bug review — tình trạng sau lần sửa 2026-11-24

Phạm vi: repo `user` (và phần ký chữ ký OAuth + schema tự cập nhật ở `gateway`). Đây là review tĩnh, chưa chạy thử
Google/Facebook login, compose hay deploy. File này chỉ ghi lại **các mục chưa sửa** và những gì cần làm khi deploy.

## 1. Cần làm trước khi/khi deploy

| # | Việc | Chi tiết |
|---|---|---|
| D1 | Deploy `user` và `gateway` **cùng lúc** | `auth.googleLogin`/`auth.facebookLogin` giờ bắt buộc chữ ký `oauthProfileSig` do gateway ký. Chỉ deploy `user` thì đăng nhập Google/Facebook qua gateway bị 403. |
| D2 | Frontend: đổi email cần `currentPassword` | `PUT /users` (tự cập nhật): khi `email` khác email hiện tại phải gửi thêm `currentPassword`. Sai/thiếu → 400 `CURRENT_PASSWORD_INCORRECT`; sai quá 5 lần/15 phút → 429. Gateway đã thêm trường này vào `updateSelfSchema`. |
| D3 | Frontend: OAuth redirect của bản HTTP trong `user` | Access token nằm ở fragment (`#accessToken=...`), refresh token ở cookie httpOnly. Không còn `?accessToken=&refreshToken=`. Gateway đã làm vậy từ trước. |
| D4 | Frontend: tutor không sửa được phụ huynh đã có | `student.update` trả 403 nếu tutor gửi trường `parent*` cho học sinh đã có phụ huynh. Chỉ gửi các trường đó khi tạo mới. |
| D5 | Đổi credential trong `docker-compose.yml` | Mật khẩu Postgres và RabbitMQ `admin/admin` đã nằm trong git history. Cổng giờ chỉ bind `127.0.0.1` nhưng credential vẫn phải đổi. Redis chưa có mật khẩu (cần đổi cấu hình bên third-service). Rà file `.env.compose` (đang được git theo dõi, chưa được mở khi review). |
| D6 | Đặt `NODE_ENV=production` ở môi trường thật | Swagger `/api-docs` tắt khi production (bật lại bằng `SWAGGER_ENABLED=true`); stack trace chỉ trả khi `NODE_ENV=development`. |
| D7 | `RPC_ACTOR_SECRET` ≥ 32 ký tự | Hiện chỉ cảnh báo khi khởi động, chưa chặn. Đổi ở cả hai service cùng lúc. |
| D8 | `gateway/src/packages/entities/user/user.schema.ts` | Hook prettier đã định dạng lại 2 dòng `avatar` không liên quan khi sửa file này. Có thể bỏ riêng 2 hunk đó nếu muốn diff gọn. |

## 2. Chưa sửa

### Cao

| # | Vấn đề | Vị trí | Vì sao chưa sửa | Hướng sửa |
|---|---|---|---|---|
| N1 | Dependency có lỗ hổng (`bun audit`: 50, gồm 3 critical, 30 high) | `package.json` | Máy dev không có `npm`, mà Dockerfile dùng `npm ci` với `package-lock.json`; chỉ sửa `bun.lock` sẽ làm build Docker lỗi. | Chạy `npm install zod@latest @nestjs/platform-express@latest` (và `npm audit fix`), commit cả `package-lock.json`, chạy lại test. Quan trọng nhất: **`zod` ≥ 4.6.6** (high, trực tiếp, cạn bộ nhớ khi validate tập lớn), `body-parser` high DoS. `proxy-addr` critical chỉ nguy hiểm khi bật `trust proxy` (chưa bật). `multer` không dùng trong `src/`. `handlebars` chỉ ở `ts-jest` (dev). |

### Trung bình

| # | Vấn đề | Vị trí | Vì sao chưa sửa | Hướng sửa |
|---|---|---|---|---|
| #14 | Khoá theo tài khoản (20 lần, không xoá khi thành công) cho phép kẻ tấn công nhiều IP khoá nạn nhân 15 phút | `auth.service.ts` `assertLoginNotLocked` | Quyết định nghiệp vụ (ghi ở memory `login-lockout-policy`). | CAPTCHA sau N lần, hoặc thông báo cho chủ tài khoản. |
| #15 | Thông báo login phân biệt `EMAIL_NOT_FOUND` / `INVALID_PASSWORD` / `ACCOUNT_NO_PASSWORD`; register báo "đã tồn tại" → dò được tài khoản | `auth.service.ts` `verifyCredentials`, `registerService` | Frontend có thể dựa vào các mã này; đổi là đổi hợp đồng API. | Một mã chung `INVALID_CREDENTIALS`; register luôn trả thành công và gửi mail "đã có tài khoản". |
| #16 | `users.userCode` không có unique index; mã TUTOR sinh bằng 24 bit ngẫu nhiên → race tạo trùng, login bằng mã mơ hồ | `user.service.ts` (`generateUserCode`), schema | Cần migration ở `../gateway`. | Thêm unique index ở gateway, đồng bộ `prisma/schema.prisma`, bắt `P2002` khi tạo. |
| #19 | Chữ ký actor chỉ phủ `actorId|role|sid|ts`, không gắn với pattern/payload. Trong 5 phút, ai chặn được envelope và gửi trước bản gốc có thể dùng chữ ký đó cho lệnh khác | `rpc-actor-signature.helper.ts` | Đổi giao thức ở cả hai repo, cần deploy đồng bộ; `withActorSignature` chưa biết pattern. | Thêm `pattern` và hash payload vào chuỗi ký; `RmqProducer.send` truyền pattern xuống. |
| #25 | Login không bắt buộc `emailVerified`; tài khoản đăng ký bằng email mạo danh dùng được ngay | `auth.service.ts` `issueLoginResponse` | Quyết định nghiệp vụ, ảnh hưởng người dùng hiện có. | Chặn các thao tác nhạy cảm (hoặc login) tới khi verify. |
| #27 | `StudentService.update` ghi học sinh và phụ huynh thành hai lần riêng, không transaction | `student.service.ts` | Cần thiết kế lại repo (nhiều đường ghi). | Gom vào một `$transaction`. |
| N2b | `student.generateCode` (RPC) không kiểm tra actor | `student.rpc.controller.ts` | Gateway gọi nó không kèm actor; thêm kiểm tra sẽ làm hỏng endpoint. | Gateway forward actor, rồi thêm `assertStaff`. |

### Thấp

| # | Vấn đề | Vị trí | Ghi chú |
|---|---|---|---|
| N4 | `UserModule` khai `JwtService`, `ConfigService` trực tiếp trong `providers` (instance không có cấu hình JWT) | `user.module.ts` | Chạy được vì code luôn truyền secret tường minh. Dùng `imports` cho sạch; cần kiểm tra DI khi khởi động thật. |
| #23 | `refreshTokens` lấy GETDEL hash trước; nếu bước kiểm tra session sau đó lỗi 503 thì phiên mất, phải đăng nhập lại | `auth.service.ts` | Đã cân nhắc (an toàn hơn so với khả dụng). |
| #26 | Strategy Google/Facebook có giá trị dự phòng `dev-missing-...`, Facebook dùng `!` cho biến chưa chắc có | `google.strategy.ts`, `facebook.strategy.ts` | Gateway đã fail-fast khi thiếu; `user` chưa làm vì sẽ không khởi động được ở môi trường thiếu biến. |
| #21b | bcrypt cắt mật khẩu ở 72 byte, schema cho tới 100 ký tự | `password.schema.ts` | Cần thêm kiểm tra theo byte + thông báo lỗi mới (cần entry i18n). |
| — | Chưa có `helmet` và rate-limit HTTP (`@nestjs/throttler`) | `main.ts` | Cần cài gói bằng `npm`. Service này chủ yếu phục vụ qua RPC; ưu tiên thấp nếu không mở HTTP ra ngoài. |
| — | Log vẫn chứa email (đã che điện thoại/địa chỉ/ngày sinh) | interceptors | Che hẳn nếu chính sách dữ liệu yêu cầu. |
| — | Giới hạn 3 mã reset/giờ và 10 lần đoán/giờ cho phép kẻ khác tạm khoá khả năng đặt lại mật khẩu của nạn nhân | `auth.service.ts` | Đánh đổi có chủ đích để chặn brute-force. |
| — | `gateway`: 3 test route student fail (`update is ADMIN only`) | `gateway/test` | Có từ trước (đã xác minh bằng stash); route cho TUTOR sửa học sinh khác với kỳ vọng của test. Cần xác nhận chủ ý rồi sửa route hoặc test. |

## 3. Đã sửa (tóm tắt)

- Tutor tạo phụ huynh nhưng không sửa; chỉ gắn phụ huynh của mình (`findParentForActor`); admin đổi email phụ huynh thì re-verify + revoke.
- OAuth RPC có chữ ký gateway (dùng một lần); mọi payload `auth.*` được validate bằng Zod như route HTTP.
- OTP reset: giới hạn tích luỹ 10 lần/giờ/tài khoản, tối đa 3 mã/giờ/email.
- Token OAuth không còn nằm trong query string; compose bind `127.0.0.1`.
- Log che `currentPassword`, chữ ký, điện thoại, địa chỉ; `health.postgres` chỉ đếm; xoá strategy JWT chết; debug `kafka.*` không log giá trị.
- HTTP login truyền IP; ghi mật khẩu sau khi revoke; đổi email cần mật khẩu + giới hạn thử; admin đổi email reset verify.
- Giới hạn `search` (100 ký tự, 5 từ); avatar chỉ http(s); bcrypt cost 12; `compareData` fail-closed; stack chỉ ở development; Swagger tắt ở production.
