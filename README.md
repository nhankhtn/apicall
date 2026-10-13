# ApiCall Runner

API client chạy local, làm theo Postman: soạn request, environment, script `pm.*`, Collection Runner, load test, và CLI runner cho CI. Giao diện React (Vite) theo style của libre/gui/web, kèm một Node server nhỏ.

## Chạy

```bash
npm install

# Dev: API server :3939 + Vite :5173 (hot reload). Mở http://localhost:5173
npm run dev

# Bản build: server serve luôn UI. Mở http://localhost:3939
npm run build
npm start
```

| Biến môi trường | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | `3939` | Cổng server |
| `HOST` | `127.0.0.1` | Đặt `0.0.0.0` để máy khác truy cập |
| `DATA_DIR` | `./data` | Dữ liệu cũ phía server (chỉ dùng để chuyển sang trình duyệt một lần) |
| `APICALL_USER`, `APICALL_PASSWORD` | — | Bật đăng nhập HTTP Basic cho cả UI lẫn API. **Bắt buộc nên đặt** khi người khác truy cập được, vì proxy gửi request đi bất cứ đâu |
| `APICALL_ALLOWED_HOSTS` | — | Khi chưa bật đăng nhập, server chỉ phục vụ `localhost`/`127.0.0.1` (chống DNS rebinding). Liệt kê thêm host/IP được phép, cách nhau bởi dấu phẩy, vd `10.0.0.5,apicall.lan` |

## Dữ liệu lưu ở đâu

Mọi thứ nằm trong **IndexedDB của trình duyệt** (mỗi trình duyệt/profile một workspace riêng, nhiều người dùng chung server không ghi đè nhau): collection, environment, globals, cookie, settings, draft, lịch sử, kết quả runner, file đính kèm, vault.

- Dữ liệu gắn theo origin: `localhost:3939`, `127.0.0.1:3939`, `localhost:5173` là ba workspace khác nhau.
- App xin quyền lưu trữ lâu dài (`navigator.storage.persist()`); xem trạng thái ở Settings → Data.
- Xoá dữ liệu trang trong trình duyệt là mất. Sao lưu bằng **Settings → Data → Export backup** (kèm cả file đính kèm), khôi phục bằng Import.
- Lần đầu mở bản mới, dữ liệu cũ trong `data/workspace.json` được chép vào trình duyệt tự động.

## Deploy

Các lệnh hay dùng đã có sẵn trong `Makefile` (`make help` để xem):

| Lệnh | Việc |
|---|---|
| `make dev` / `make start` | Chạy dev (Vite + server) / build rồi chạy bản production |
| `make docker-run APP_USER=admin APP_PASS=…` | Build image và chạy container trên :3939 (`PORT=…` để đổi cổng, `HOSTS=…` cho APICALL_ALLOWED_HOSTS) |
| `make docker-logs` / `make docker-stop` | Xem log / dừng container |
| `make push REGISTRY=myreg.azurecr.io` | Build image tag `<commit>-<thời gian>` + `latest` rồi push lên registry đã login |
| `make publish GHCR=ghcr.io/<you>/apicall` | Push lên GitHub Container Registry (login qua `gh`) |
| `make vercel-env APP_USER=… APP_PASS=…` rồi `make vercel-prod` | Đặt login cho Vercel và deploy production |
| `make cli ARGS='run ./x.postman_collection.json -e ./env.json'` | Chạy CLI runner |

### Docker

```bash
docker build -t apicall .
docker run -d --name apicall -p 3939:3939 \
  -e APICALL_USER=admin -e APICALL_PASSWORD='đổi-mật-khẩu' \
  -v apicall-data:/data apicall
```

Image chạy bằng user `node` (không phải root), có healthcheck `/api/health`. Truy cập qua IP/tên miền khác `localhost` thì phải bật đăng nhập hoặc đặt `APICALL_ALLOWED_HOSTS`. Bản Docker có đủ tính năng, kể cả WebSocket/Socket.IO/MQTT/gRPC.

### Vercel

```bash
npx vercel            # hoặc import repo trên vercel.com, framework: Vite
```

Đặt `APICALL_USER` và `APICALL_PASSWORD` trong Project → Settings → Environment Variables (middleware.js khoá toàn bộ site bằng Basic auth). `vercel.json` build `dist/` và chuyển `/api/*` vào function `api/index.js`.

Giới hạn trên Vercel:
- **Không có WebSocket, Socket.IO, MQTT, gọi gRPC** (serverless function không giữ kết nối). Xem danh sách method gRPC thì vẫn được.
- Proxy chạy trên cloud của Vercel: **không gọi được API nội bộ, VPN, localhost**.
- Request body tối đa ~4 MB, mỗi request tối đa 60 giây.

## CLI runner (cho CI)

Workspace nằm trong trình duyệt, nên CLI chạy từ file export: chuột phải collection → Export (Postman v2.1), environment → Export.

```bash
npx apicall run ./shop.postman_collection.json -e ./local.postman_environment.json -d orders.csv \
  --reporters cli,junit --reporter-junit-export out/junit.xml
```

`-f` chạy riêng folder, `-n` số iteration, `--env-var k=v`, `--delay-request`, `--timeout-request`, `-k` bỏ kiểm tra SSL, `--bail` dừng ở lỗi đầu tiên, `--export-environment`. Exit code 1 khi có request/test fail. Xem đủ: `npx apicall --help`.

## Kiến trúc

```
Browser (React)                                     server/index.mjs (hoặc api/index.js trên Vercel)
 ├─ IndexedDB: workspace, history, runs, files       ├─ POST /api/proxy     → server/proxy.mjs → API đích
 ├─ engine.worker.js: scripts + HTTP engine          ├─ WS   /api/realtime  → server/realtime.mjs (WS, Socket.IO, MQTT, gRPC)
 └─ realtime.js: một WebSocket chở mọi phiên         └─ POST /api/grpc/describe → server/grpc.mjs
bin/cli.mjs: cùng engine, gọi thẳng server/proxy.mjs (không cần server chạy)
```

- `src/lib/engine.js`: chạy request (script, cookie, Digest retry, OAuth2), collection run, load test.
- `src/lib/build.js`: dựng request cuối cùng (path variable, body, auth, cookie, setting).
- `src/lib/sandbox.js`: API `pm.*`. `src/lib/vars.js`: biến. `src/lib/cookies.js`: cookie jar.
- `src/lib/authsign.js`: AWS SigV4, Digest, JWT, Hawk. `server/ntlm.mjs`: bắt tay NTLM. `src/lib/codegen.js`: sinh code 18 ngôn ngữ.
- `src/lib/model.js`: model, import/export Postman v2.1, parse cURL (bash và Windows cmd).
- `src/db.js`, `src/persist.js`: IndexedDB và đồng bộ giữa các tab.

## Tính năng

**Soạn request**
- Tab như Postman (preview tab, kéo thả, menu chuột phải), draft chưa lưu có chấm báo, Ctrl+S / Save As / Revert, tab request mới chưa thuộc collection.
- Ô nhập tô màu `{{biến}}` (xanh: đã định nghĩa, đỏ: chưa), gõ `{{` để gợi ý, hover để xem giá trị và scope. CodeMirror trong body cũng vậy.
- Params: query param bật/tắt từng dòng, bảng path variable (`/orders/:id`), description.
- Body: none, form-data (text + file), x-www-form-urlencoded, raw (JSON/Text/XML/HTML/JS), binary, GraphQL (query + variables).
- Auth: Bearer, Basic, API Key, JWT (HS/RS/PS/ES), Digest, OAuth 2.0 (client credentials, password, refresh token, authorization code + PKCE qua popup, tự lấy token khi chạy), AWS Signature v4, Hawk, NTLM (v2); kế thừa từ folder/collection.
- Settings từng request: SSL verify, follow redirects, cookie jar, timeout.
- Dán cURL vào ô URL tự điền request; Copy as cURL; sinh code 18 ngôn ngữ.

**Response**
- Pretty / Raw / Preview (HTML, ảnh, PDF) / Visualize (`pm.visualizer`, Handlebars), tìm kiếm, copy, lưu ra file.
- Tab Cookies, Headers, Test Results (lọc), Console, Request đã gửi; thời gian tách TTFB/download, kích thước tách header/body.
- Save as example; example hiện dưới request trong sidebar, sửa được.

**Biến và môi trường**
- Environment, collection variables, globals với Initial / Current value, kiểu secret (che), Persist all / Reset all.
- Vault (`{{vault:key}}`, `pm.vault`), dynamic variables (`{{$guid}}`, `{{$timestamp}}`, `{{$randomEmail}}`… ~60 loại).
- Cookie jar tự động + màn hình quản lý cookie theo domain.

**Runner**
- Functional: chọn và sắp xếp lại request ngay trong runner, iterations, delay, data CSV/JSON, stop on failure, giữ giá trị biến, lọc pass/fail, xem chi tiết, export report, lịch sử các lần chạy.
- Performance: virtual users, thời lượng, ramp-up; biểu đồ response time và throughput, p50/p90/p95/p99, error rate, thống kê theo request.

**Script (`pm.*`)**
`pm.test/expect`, `pm.response.*` (+ `to.have.jsonSchema`, `to.have.responseTime.below`, `to.have.cookie`…), `pm.request.*` (url/query/path variables/headers/body), `pm.environment`, `pm.collectionVariables`, `pm.globals`, `pm.variables`, `pm.iterationData`, `pm.cookies` + `pm.cookies.jar()`, `pm.vault`, `pm.visualizer`, `pm.sendRequest`, `pm.execution.setNextRequest/skipRequest`, `pm.info`, API cũ (`postman.*`, `tests[]`, `responseBody`…), `setTimeout`, `xml2Json`, `cheerio`, `tv4`, `CryptoJS`, `_`, `moment`, `require(...)`, top-level `await`.

**Khác**: import/export Postman Collection v2.0/2.1 và environment (giữ path variable, param tắt, example, file, auth, setting), backup workspace, proxy (bypass list), client certificate (mTLS), sáng/tối, CLI runner.

**Loại request khác HTTP** (nút New, hoặc chuột phải collection → Add … request)
- WebSocket: header handshake, subprotocol, gửi text/JSON/binary, tin nhắn đã lưu, log có tìm kiếm.
- Socket.IO (v3/v4): path, auth handshake, nghe event (kể cả `*`), emit kèm ack.
- MQTT 3.1.1/5 (mqtt, mqtts, ws, wss): subscribe theo topic/QoS, publish, retain.
- gRPC: server reflection hoặc import file .proto, chọn method, ví dụ message tự sinh, metadata, deadline, TLS; unary và cả 3 kiểu streaming.
- Các loại này lưu trong collection như request thường nhưng không nằm trong runner và không export ra Postman v2.1 (định dạng đó không hỗ trợ); backup workspace thì giữ đủ.

## Chưa có

- Tính năng cloud của Postman: đồng bộ, chia sẻ team, mock server, monitor, publish docs.
- Auth Akamai EdgeGrid, Kerberos (NTLM chỉ hỗ trợ NTLMv2).
- Thời gian DNS/TCP/TLS tách riêng (chỉ có TTFB và download).

## Lưu ý bảo mật

Script chạy trong Web Worker nên không đọc được trang, localStorage hay vault của app, nhưng vẫn gọi được mạng qua `pm.sendRequest`. Chỉ import collection từ nguồn tin cậy. Load test tạo traffic thật, hãy dùng môi trường test.
