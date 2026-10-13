# ApiCall Runner

API client chạy local, có Collection Runner giống Postman. Viết bằng React (Vite) và một Node server nhỏ.

## Chạy

```bash
npm install

# Dev: API server :3939 + Vite :5173 (hot reload). Mở http://localhost:5173
npm run dev

# Bản build: server serve luôn UI. Mở http://localhost:3939
npm run build
npm start
```

Biến môi trường của server:

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | `3939` | Cổng server |
| `HOST` | `127.0.0.1` | Đặt `0.0.0.0` để máy khác trong LAN truy cập |
| `DATA_DIR` | `./data` | Nơi lưu `workspace.json` |
| `INSECURE_TLS` | — | `1` = chấp nhận cert tự ký (môi trường nội bộ). Chỉ bật khi cần |

## Kiến trúc

```
Browser (React)                           server.js
 ├─ engine: biến, pm.* sandbox, runner  ─► POST /api/proxy ─► API đích (không bị CORS)
 └─ autosave                            ─► PUT  /api/workspace ─► data/workspace.json
```

- `src/lib/engine.js`: resolve `{{var}}`, sandbox script `pm`, chạy một request, chạy collection.
- `src/lib/model.js`: cấu trúc dữ liệu, import/export Postman v2.1, parse cURL.
- `src/runner.js`, `src/actions.js`, `src/store.js`: state (zustand + immer) và các thao tác UI.
- `src/components/`: giao diện.

## Tính năng

- Collection, folder, request; kéo thả để sắp xếp; double-click để đổi tên.
- Params, headers (có bulk edit), body (raw JSON/Text/XML, x-www-form-urlencoded, form-data dạng text).
- Auth: Bearer, Basic, API Key; kế thừa từ folder/collection.
- Environment, collection variables, globals, dynamic vars (`{{$guid}}`, `{{$timestamp}}`, `{{$randomInt}}`…).
- Script pre-request và test ở cả 3 cấp collection → folder → request, theo đúng thứ tự Postman.
- **Collection Runner**: chọn request, iterations, delay, data file CSV/JSON, stop on failure, lưu biến lại sau khi chạy, lọc pass/fail, xem chi tiết từng request, export report JSON.
- Import Postman Collection v2.0/v2.1, Postman environment, cURL (kể cả "Copy as cURL" từ Chrome DevTools). Export ra Postman v2.1. Có "Copy as cURL".

### Script API hỗ trợ

`pm.test`, `pm.expect` (chai), `pm.response.*` (`json()`, `text()`, `code`, `headers`, `cookies`, `responseTime`, `to.have.status/header/jsonBody`, `to.be.ok/success/…`),
`pm.request.*` (sửa url/query/headers/body trong pre-request), `pm.environment`, `pm.collectionVariables`, `pm.globals`, `pm.variables`, `pm.iterationData`,
`pm.sendRequest` (callback hoặc `await`), `pm.execution.setNextRequest/skipRequest`, `pm.info`, `postman.setNextRequest` và các API cũ (`tests[]`, `responseBody`…),
`setTimeout`, `CryptoJS`, `_` (lodash), `moment`, `require('crypto-js' | 'lodash' | 'moment' | 'chai' | 'uuid')`. Script được dùng `await` ở top-level.

`pm.execution.setNextRequest(null)` kết thúc iteration hiện tại (giống Newman).

### Chưa hỗ trợ

Upload file trong form-data, OAuth 1/2 và các kiểu auth khác (vẫn giữ nguyên khi export lại), cookie jar tự động, GraphQL editor riêng (body GraphQL được import thành raw JSON).

### Lưu ý bảo mật

Script trong collection chạy trực tiếp trong trang. Chỉ import collection từ nguồn bạn tin cậy.
