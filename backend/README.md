# SimpleChatRoom 后端

后端使用 Express 提供 REST API，使用 Socket.IO 提供实时聊天，TypeScript 提供类型检查。数据保存在 SQLite 文件中，服务默认监听 `0.0.0.0:3000`。

## 启动

```bash
npm install
npm run dev
```

### 其他命令：

```bash
npm run tsc       # TypeScript 类型检查
npm run start     # 直接启动 src/index.ts
```

后端启动时会自动创建 `backend/data/chat.db`、数据表和消息索引；如果没有房间，会创建“公共大厅”。日志写入当前工作目录的 `latest.log`。

## 认证规则

需要认证的 HTTP 请求加入：

```http
Authorization: Bearer <token>
```

token 由匿名进入、注册或登录接口返回，固定有效期为 30 天。当前没有 token 续期机制：`GET /api/auth/me` 只校验 token，不会延长有效期，也不会返回新 token。数据库只保存 token 的 SHA-256 哈希。通用错误格式为 `{ "error": "错误说明" }`。

请求体不是合法 JSON 时统一返回 `400`；CORS 预检 `OPTIONS` 请求直接返回 `204`，不会进入路由。

token 过期后，需要重新登录或重新匿名进入；当前没有 refresh token、`/api/auth/refresh`、服务端注销或撤销 token 接口。过期的 session 记录也不会自动清理。

限制：用户名最长 32 个字符；密码为 6-128 个字符；消息最多 2000 个字符；房间名称最多 32 个字符；私有房间密码最多 64 个字符。

## 数据结构

接口和事件在 JSON 中传递以下结构（与 `shared/types.ts` 对应）：

- **User**：`{ "id": number, "username": string, "status": "anonymous" | "registered" | "admin" | "banned" }`。
- **Room**：`{ "id": number, "name": string, "isPublic": boolean, "creatorId": number, "createdAt": number }`；`creatorId` 为 `0` 表示系统播种的“公共大厅”。
- **RoomInfo**：在 `Room` 基础上追加 `isMember`（请求者是否已加入）和 `unreadCount`（请求者在该房的未读数，非成员恒为 `0`）。REST 返回房间信息时使用 `RoomInfo`；`room:created` 广播只下发基础 `Room`。
- **ChatMessage**：`{ "id": number, "roomId": number, "senderId": number, "username": string, "timestamp": number, "text": string }`。

## REST 接口

### `GET /`

返回 `Hello world` HTML，是当前的简单占位接口，不是正式健康检查接口。

### `POST /api/auth/anonymous`

匿名创建用户和会话，不需要请求体。

```bash
curl -X POST http://localhost:3000/api/auth/anonymous
```

返回 `201`：

```json
{
  "user": { "id": 1, "username": "游客_A1B2C3", "status": "anonymous" },
  "token": "..."
}
```

### `POST /api/auth/register`

注册正式用户。

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"secret123"}'
```

用户名重复返回 `409`，参数不合法返回 `400`。

### `POST /api/auth/login`

登录已有正式用户。

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"secret123"}'
```

用户名或密码错误返回 `401`，被封禁用户返回 `403`。

### `GET /api/auth/me`

查询当前 token 对应的用户：

```bash
curl http://localhost:3000/api/auth/me \
  -H "Authorization: Bearer <token>"
```

返回 `{ "user": { ... } }`；该接口只校验 token，不会续期。

### `POST /api/auth/upgrade`

把当前匿名用户升级为正式用户，保留原用户 ID、房间成员关系和历史消息。

```bash
curl -X POST http://localhost:3000/api/auth/upgrade \
  -H "Authorization: Bearer <anonymous-token>" \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"secret123"}'
```

仅 `anonymous` 用户可调用，非匿名用户返回 `400`；用户名重复返回 `409`。成功后返回 `{ "user": ..., "token": "..." }`，即**签发一个新的 token**；原匿名 token 暂时不会被撤销。

### `GET /api/users/:id`

登录后按 ID 查询用户的公开基础信息。

```bash
curl http://localhost:3000/api/users/1 \
  -H "Authorization: Bearer <token>"
```

`id` 非法（非正整数）返回 `400`，用户不存在返回 `404`。响应体为 `{ "id", "username", "status" }`，这不是完整的用户管理接口。

### `POST /api/rooms`

创建聊天室，创建者自动成为成员。

公共房间：

```bash
curl -X POST http://localhost:3000/api/rooms \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"技术交流","isPublic":true}'
```

私有房间：

```bash
curl -X POST http://localhost:3000/api/rooms \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"小组讨论","isPublic":false,"password":"room-pass"}'
```

请求体必须为 `{ "name": "...", "isPublic": true }`；房间名去除首尾空白后不能为空且不超过 32 个字符。匿名用户不能创建公共聊天室；公共聊天室不能带 `password`；私有聊天室必须带非空密码。返回 `201` 的 `RoomInfo` 还包括 `isMember` 和 `unreadCount`。

### `GET /api/rooms`

返回当前用户可见的房间：全部公共房间，以及已加入的私有房间。

```bash
curl http://localhost:3000/api/rooms \
  -H "Authorization: Bearer <token>"
```

返回 `RoomInfo[]`。公共房间创建后还会通过 `room:created` 广播给在线用户。

### `POST /api/rooms/:id/join`

加入聊天室，重复调用幂等；私有房间需要密码。

```bash
curl -X POST http://localhost:3000/api/rooms/2/join \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"password":"room-pass"}'
```

公共房间可以不传密码。房间不存在返回 `404`，私有房间缺少或密码错误返回 `403`。

### `GET /api/rooms/:id/messages`

获取历史消息。需要登录；私有房间还必须是成员。

```bash
curl 'http://localhost:3000/api/rooms/2/messages?limit=50' \
  -H "Authorization: Bearer <token>"
```

参数：`limit` 为 1-100，默认 50；`before` 为消息 ID 游标，只返回 ID 小于它的更早消息。返回按 ID 升序排列：

```json
{
  "messages": [
    { "id": 10, "roomId": 2, "senderId": 1, "username": "alice", "text": "你好", "timestamp": 1720000000000 }
  ],
  "hasMore": false
}
```

下一页使用当前页第一条消息的 `id` 作为 `before`。

## Socket.IO 实时接口

连接地址为 `http://localhost:3000`，握手时必须传 token：

```ts
import { io } from 'socket.io-client';
const socket = io('http://localhost:3000', { auth: { token } });
```

### 客户端事件 `room:enter`

进入并订阅房间。公共房间会记录成员；私有房间必须先通过 REST 接口加入。

```ts
socket.emit('room:enter', roomId, (result) => {
  // 成功：{ ok: true, room: RoomInfo }
  // 失败：{ ok: false, error: string }
});
```

进入房间会把当前用户该房间的未读数清零。

### 客户端事件 `room:leave`

离开 Socket.IO 频道，但保留成员关系：

```ts
socket.emit('room:leave', roomId);
```

### 客户端事件 `message`

发送消息。服务端校验权限、截断到 2000 个字符、写入数据库后广播：

```ts
socket.emit('message', { roomId: 2, text: '大家好' }, (result) => {
  // 成功：{ ok: true }
  // 失败：{ ok: false, error: string }
});
```

常见失败原因：`消息不能为空`、`聊天室不存在`、`你不是该聊天室的成员`。若发送时不在对应 Socket.IO 频道（重连/竞态），服务端会补校验成员关系并自动入房后再广播；私有房非成员此时仍会被拒。

### 服务端事件 `message`

房间内有新消息时广播给该房间所有连接，包括发送者：

```ts
socket.on('message', (message) => {
  // message: ChatMessage
});
```

### 服务端事件 `room:created`

公共聊天室创建成功后广播给所有在线用户，私有聊天室不广播：

```ts
socket.on('room:created', (room) => {
  // room: Room
});
```

### 服务端事件 `unread`

房间有新消息或用户进入房间时，向该用户的所有连接推送未读数。未读数只统计**他人发送**的消息（自己发的不计入），非成员恒为 `0`：

```ts
socket.on('unread', ({ roomId, unreadCount }) => {
  // 更新对应房间的未读数
});
```

## 目录结构

```
backend/
├── src/
│   ├── index.ts          # 服务入口：Express 路由、鉴权中间件与 Socket.IO 实时事件
│   ├── db.ts             # SQLite 建表、预编译语句与数据访问函数（启动时播种“公共大厅”）
│   └── utils/
│       ├── password.ts   # scrypt 密码哈希与校验
│       └── logger.ts     # 重写 console 方法，将日志写入 latest.log
├── data/
│   └── chat.db           # SQLite 数据文件（运行时自动创建）
├── package.json          # 依赖与 npm 脚本（dev / start / tsc）
├── tsconfig.json         # TypeScript 配置
├── latest.log            # 运行日志（当前工作目录，自动生成）
└── README.md             # 本文档

../shared/
└── types.ts              # 前后端共用的类型定义（User / Room / RoomInfo / ChatMessage 等）
```

> `node_modules/`、`data/` 和 `*.log` 已在 `backend/.gitignore` 中忽略，不随仓库提交。

## 当前限制

- CORS 当前为 `*`，只适合开发环境。
- 端口、限制和会话时长直接写在 `src/index.ts`，还没有环境变量配置。
- Socket.IO 使用单进程内存频道，多实例部署需要共享适配器。
- 没有管理员、好友和消息编辑/删除接口等。
