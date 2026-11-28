# Security và bug còn lại: user (cập nhật 2026-11-28)

Nguồn: file này trước đó ghi tình trạng sau lần sửa 2026-11-24. Các mục F-xx đã chuyển sang `report.md`.
Trạng thái: **Đã fix** = xong; **Fix một phần** = còn việc; **Chưa xong** = chưa sửa; **Việc deploy** = cần làm khi triển khai.

| ID | Mức độ | Loại | Vấn đề | Trạng thái | Còn cần làm |
|---|---|---|---|---|---|
| N1 | High | Security | Dependency có lỗ hổng (`bun audit`: 50, gồm 3 critical, 30 high) | Chưa xong | Chạy `npm install` với `package-lock.json`, commit lock, test lại. Ưu tiên `zod` ≥ 4.6.6 và `body-parser`. |
| #14 | Medium | Security | Khoá theo tài khoản cho phép khoá nạn nhân từ nhiều IP | Chưa xong | Quyết định nghiệp vụ (CAPTCHA sau N lần hoặc thông báo cho chủ tài khoản). |
| #15 | Medium | Security | Login và register lộ sự tồn tại tài khoản | Fix một phần | Register: email đã đăng ký trả phản hồi giống đăng ký mới (F-09). Còn: login chưa đổi sang `INVALID_CREDENTIALS` chung, timing register, mail thông báo cho chủ email. |
| #16 | Medium | Bug | `users.userCode` không có unique index, race khi tạo trùng | Chưa xong | Migration ở `gateway`, bắt `P2002` khi tạo. |
| #19 | Medium | Security | Chữ ký actor không gắn pattern/payload (bản 2026-11-24) | Đã fix | Xem F-02. |
| #25 | Medium | Security | Login không bắt buộc `emailVerified` | Chưa xong | Quyết định nghiệp vụ, ảnh hưởng người dùng hiện có. |
| #27 | Medium | Bug | `StudentService.update` ghi hai lần không transaction | Đã fix | Xem F-15. |
| N2b | Medium | Security | `student.generateCode` không kiểm tra actor | Đã fix | Xem F-14. |
| N4 | Low | Bug | `UserModule` khai `JwtService`, `ConfigService` trực tiếp trong `providers` | Chưa xong | Chuyển sang `imports`, kiểm tra DI khi khởi động thật. |
| #23 | Low | Design | `refreshTokens` mất phiên nếu bước kiểm tra lỗi 503 | Đóng | Đã cân nhắc: an toàn hơn khả dụng. |
| #21b | Low | Security | bcrypt cắt mật khẩu ở 72 byte (bản cũ) | Đã fix | Xem F-16. |
| — | Low | Hardening | Chưa có `helmet` và rate-limit HTTP | Chưa xong | Cài gói bằng `npm`. Ưu tiên thấp nếu không mở HTTP ra ngoài. |
| — | Low | Privacy | Log vẫn chứa email (đã che điện thoại, địa chỉ, ngày sinh) | Fix một phần | Che hẳn nếu chính sách dữ liệu yêu cầu (xem F-08). |
| — | Low | Design | Giới hạn 3 mã reset/giờ có thể tạm khoá khả năng đặt lại mật khẩu của nạn nhân | Đóng | Đánh đổi có chủ đích để chặn brute-force. |
| — | Low | Test | 3 test route student fail (`update is ADMIN only`) ở `gateway` | Đã fix | Đã đổi test theo quyền ADMIN+TUTOR (`assertCanManage` ở user-service). |
| D1 | Deploy | Việc deploy | `user` và `gateway` phải deploy cùng lúc (chữ ký OAuth) | Việc deploy | Chỉ deploy `user` thì đăng nhập Google/Facebook qua gateway bị 403. |
| D2 | Deploy | Frontend | Đổi email cần `currentPassword` | Việc deploy | Frontend cần gửi trường này. Gateway đã thêm vào `updateSelfSchema`. |
| D3 | Deploy | Frontend | OAuth redirect của bản HTTP đưa token vào fragment | Việc deploy | Frontend cần đọc fragment `#accessToken=...`. |
| D4 | Deploy | Frontend | Tutor không sửa được phụ huynh đã có | Việc deploy | Frontend chỉ gửi trường `parent*` khi tạo mới. |
| D5 | Deploy | Security | Đổi credential trong `docker-compose.yml` | Việc deploy | Xem F-06. Redis cần mật khẩu bên third-service. |
| D6 | Deploy | Config | Đặt `NODE_ENV=production` ở môi trường thật | Việc deploy | Swagger tắt khi production; stack trace chỉ khi development. |
| D7 | Deploy | Config | `RPC_ACTOR_SECRET` ≥ 32 ký tự | Việc deploy | Hiện chỉ cảnh báo; đổi ở cả hai service cùng lúc. |
| D8 | Deploy | Git | `gateway/src/packages/entities/user/user.schema.ts` có hunk định dạng không liên quan | Việc deploy | Bỏ riêng hai hunk `avatar` nếu muốn diff gọn. |
