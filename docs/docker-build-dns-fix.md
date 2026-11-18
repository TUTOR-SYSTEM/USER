# Sửa lỗi `docker build` timeout DNS (Kiri + BuildKit)

## Triệu chứng

```
ERROR resolve image config for docker-image://docker.io/docker/dockerfile:1
failed to do request: Head "https://registry-1.docker.io/v2/docker/dockerfile/manifests/1":
dial tcp: lookup registry-1.docker.io on 8.8.4.4:53: read udp 172.17.0.2:44542->8.8.4.4:53: i/o timeout
```

Build treo ~100s rồi lỗi ngay ở bước đầu (kéo frontend `docker/dockerfile:1`), chưa chạy tới bước nào của `Dockerfile`.

## Nguyên nhân gốc

- Máy host dùng stub của systemd-resolved (`127.0.0.53`), container không truy cập được.
- Container engine là **Kiri** (tương thích Docker, `Server: Kiri 27.5.1`, socket `/run/kiri/docker.sock`). Khi không có DNS dùng được, Kiri đặt mặc định `8.8.8.8` / `8.8.4.4` cho container.
- Mạng wifi **chặn DNS UDP trực tiếp** ra ngoài (kể cả `8.8.8.8`, `8.8.4.4`, `1.1.1.1`). Chỉ resolver của LAN (`192.168.180.188`, DNS của `wlan0`) hoạt động.
- Container BuildKit (`buildx_buildkit_default`, driver `docker-container`) có mạng riêng và dùng `8.8.8.8` / `8.8.4.4` nên luôn timeout.

## Các bước đã thực hiện

### 1. Xác định lỗi chỉ nằm ở container BuildKit

```bash
getent hosts registry-1.docker.io      # host phân giải bình thường
docker buildx ls                       # chỉ có builder `default` (docker-container)
cat /etc/resolv.conf                   # 127.0.0.53 (systemd-resolved stub)
```

### 2. Thử `network=host` (không thành công)

```bash
docker buildx create --name hostnet --driver docker-container \
  --driver-opt network=host --use
docker buildx inspect --bootstrap
```

Lỗi: `mount .../rootfs: Resource busy (os error 16)` — Kiri không boot được container BuildKit với `network=host`. Builder `hostnet` rơi vào trạng thái `stopped`, build vẫn chạy trên `default` nên lỗi DNS lặp lại.

### 3. Tìm DNS thật sự dùng được

```bash
resolvectl status | grep -E "Link|DNS Server"
docker exec buildx_buildkit_default cat /etc/resolv.conf   # nameserver 8.8.8.8 / 8.8.4.4
dig +time=2 +tries=1 @8.8.4.4 registry-1.docker.io         # timed out
dig +time=2 +tries=1 @8.8.8.8 registry-1.docker.io         # timed out
dig +time=2 +tries=1 @1.1.1.1 registry-1.docker.io         # timed out
```

Kết quả: chỉ `192.168.180.188` (DNS của `wlan0`) dùng được.

### 4. Dọn builder hỏng và trỏ DNS của BuildKit sang resolver của LAN

```bash
docker buildx rm hostnet
docker buildx use default
docker exec buildx_buildkit_default sh -c \
  'printf "nameserver 192.168.180.188\n" > /etc/resolv.conf'
docker exec buildx_buildkit_default nslookup registry-1.docker.io   # OK
```

### 5. Build lại

```bash
docker build --load -t user .
```

Thành công, image `user` được nạp vào Docker. `--load` cần thiết vì driver `docker-container` mặc định chỉ giữ kết quả trong build cache.

## Lưu ý

- Cách sửa **chỉ tạm thời**: `/etc/resolv.conf` trong container BuildKit sẽ về `8.8.8.8` nếu container bị tạo lại (restart Kiri, reboot). Khi đó chạy lại lệnh ở bước 4.
- `192.168.180.188` là DNS của wifi hiện tại. Đổi mạng thì phải đổi địa chỉ này (xem bằng `resolvectl status`).
- Lần build thành công phần lớn dùng layer cache (`CACHED`). Muốn kiểm chứng build từ đầu, thêm `--no-cache`.
- Nếu cần cố định lâu dài, cấu hình DNS cho Kiri (nếu hỗ trợ) thay vì sửa tay trong container.
