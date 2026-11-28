# Báo cáo bug: user (identity/admin service)

Cập nhật: 2026-11-28, theo báo cáo review tĩnh 2026-11-27.
Trạng thái: **Đã fix** = xong; **Fix một phần** = còn việc; **Chưa xong** = chưa sửa; **Việc deploy** = cần làm khi triển khai.

| ID | Mức độ | Loại | Vấn đề | Trạng thái | Còn cần làm |
|---|---|---|---|---|---|
| F-09 | Low | Security | Lộ sự tồn tại tài khoản (message và timing) | Fix một phần | Đăng ký trùng email trả phản hồi giống đăng ký mới (201, id ngẫu nhiên, không ghi DB) và gửi mail thông báo cho chủ email qua `email.sendAccountExists` (`third`, best-effort, `registerDecoy`). Trùng username giữ 400 (chấp nhận lộ username). Còn lại: thời gian phản hồi còn lệch chút (nhánh thật có insert + verify mail); cần deploy `third` trước `user`. |
| F-19 | Info | Security | Fallback clientID/secret chuỗi giả cho Google | Fix một phần | Thiếu Google ở production đã từ chối khởi động. Facebook dùng `!` cho biến chưa chắc có. |
| F-06 | Medium | Security | Credential hardcode trong `docker-compose.yml`, `.env.compose` được git theo dõi | Đã fix | Compose bắt buộc biến môi trường; `.env.compose` không còn trong repo. Credential cũ vẫn nằm trong git history (commit `9b5bbee`, `808fd2c`, `cdb6dcf`), nên việc đổi mật khẩu đã làm là bắt buộc. Cùng lỗi còn ở `tutor`, xem báo cáo tutor. |
| F-01 | Medium | Security | Lockout fail-open khi Redis lỗi, lộ oracle mật khẩu | Đã fix | - |
| F-02 | Medium | Security | Chữ ký actor không bao payload và pattern | Đã fix | Triển khai `gateway` và `user` cùng lúc (bản cũ không gửi `actorBind` sẽ bị 403). |
| F-03 | Medium | Security (latent) | TUTOR gắn `parentId` tuỳ ý qua `user.createUser` | Đã fix | - |
| F-04 | Medium | Bug | Facebook callback đọc biến `GOOGLE_OAUTH_REDIRECT_URL` | Đã fix | - |
| F-05 | Medium | Security | Facebook không kiểm tra email đã xác minh | Đã fix | Xác minh lại với tài liệu Facebook (nguồn tìm được là bên thứ ba). |
| F-07 | Low | Bug | Revoke session dùng `emit`, không chờ xoá | Đã fix | - |
| F-10 | Low | Security | Admin tự vô hiệu hoá/hạ quyền chính mình; TOCTOU admin cuối | Đã fix | - |
| F-11 | Low | Security | Đổi email không revoke session | Đã fix | - |
| F-12 | Low | Security | `mustChangePassword` chỉ là cờ phía client | Đã fix | - |
| F-13 | Low | Security | Role lấy từ JWT, không đối chiếu DB | Đã fix | - |
| F-14 | Low | Security | RPC debug và `student.generateCode` không kiểm tra actor | Đã fix | - |
| F-15 | Low | Bug | Update học sinh không atomic | Đã fix | - |
| F-16 | Low | Security | Mật khẩu tới 100 ký tự nhưng bcrypt chỉ dùng 72 byte | Đã fix | Đã chặn cả 72 byte UTF-8 ở `newPasswordSchema` (có thông báo riêng) và `studentPasswordSchema` (đường tạo/sửa học sinh và phụ huynh). Login vẫn chấp nhận tới 100 ký tự. Test: `student.password-bytes.spec.ts`, `user.schema.spec.ts`. |
| F-17 | Low | Security | Message lỗi non-HTTP trả nguyên văn cho client | Đã fix | - |
| F-18 | Info | Bug | Đếm attempt fail open khi `redis.incr` trả rỗng | Đã fix | - |
| F-20 | Info | Security | `RPC_ACTOR_SECRET` ngắn chỉ cảnh báo | Đã fix | - |
| F-21 | Info | Security | `jwt.verify` không khai báo `algorithms` | Đã fix | - |
| F-08 | Low | Security | Log RPC lưu email, họ tên vào `request_logs` | Đóng | Đã xoá logic log request (LoggerInterceptor, log-sink, emit log.create), không còn ghi PII vào request_logs. |
