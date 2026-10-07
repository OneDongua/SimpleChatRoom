# SimpleChatRoom 前端

前端是 React 19、TypeScript、Vite 和 Socket.IO Client 构成的单页应用，负责登录、聊天室列表、房间切换、历史消息加载和实时消息展示。

## 启动

```bash
npm install
npm run dev
```

默认开发地址是 `http://localhost:5173`。前端会连接 `http://当前浏览器访问的主机名:3000`，因此后端需要先在 3000 端口启动。局域网访问时，设备也必须能访问后端的 3000 端口。

## 常用命令

```bash
npm run dev       # Vite 开发服务器
npm run build     # 类型检查并构建生产静态文件
npm run lint      # ESLint 检查
npm run preview   # 预览构建产物
```

## 页面功能

### 登录区域

- 匿名进入：调用 `POST /api/auth/anonymous`，无需注册即可使用公共聊天室。
- 登录：调用 `POST /api/auth/login`。
- 注册：调用 `POST /api/auth/register`。
- token 保存在浏览器 `localStorage` 的 `chat_token` 中，刷新页面后调用 `/api/auth/me` 恢复身份。
- token 固定有效期为 30 天，目前没有 refresh token 或自动续期；过期后需要重新登录或重新匿名进入。
- 切换用户会清理本地 token，并断开 Socket.IO 连接。

### 聊天区域

- 侧边栏展示当前用户可见的公共和私有聊天室。
- 创建公共或私有聊天室，通过房间 ID 和密码加入聊天室。
- 进入房间后加载最新一页历史消息，并可继续加载更早消息。
- 通过 Socket.IO 接收新消息，侧边栏显示其他房间的未读数。
- 支持移动端侧边栏展开和收起。

## 前端与后端对应关系

HTTP 请求集中在 `src/api.ts`：

| 前端方法                             | 后端接口                          |
|----------------------------------|-------------------------------|
| `anonymous()`                    | `POST /api/auth/anonymous`    |
| `login(username, password)`      | `POST /api/auth/login`        |
| `register(username, password)`   | `POST /api/auth/register`     |
| `upgrade(username, password)`    | `POST /api/auth/upgrade`      |
| `currentUser()`                  | `GET /api/auth/me`            |
| `listRooms()`                    | `GET /api/rooms`              |
| `createRoom(input)`              | `POST /api/rooms`             |
| `joinRoom(roomId, password)`     | `POST /api/rooms/:id/join`    |
| `fetchMessages(roomId, options)` | `GET /api/rooms/:id/messages` |

`upgrade()` 虽然已经封装在 API 层，但页面还未实现功能。

## Socket.IO 说明

`src/socket/socket.ts` 创建 Socket.IO 客户端，登录成功后由 `connectAs(token)` 设置握手认证并连接。

`src/hooks/useChatSocket.ts` 负责连接生命周期、房间进入/离开、创建和加入房间、发送消息、历史分页、消息去重、未读数更新，以及断线重连后的补齐。

监听的服务端事件：`message`、`room:created`、`unread`。

发送的客户端事件：`room:enter`、`room:leave`、`message`。

## 目录说明

```text
src/
├─ App.tsx                    页面入口和认证状态
├─ api.ts                     REST 请求封装
├─ components/
│  ├─ Sidebar.tsx             房间列表、创建和加入房间
│  ├─ MessageList.tsx         消息列表和历史消息加载
│  └─ ChatInput.tsx           消息输入和错误提示
├─ hooks/
│  ├─ useChatSocket.ts        聊天状态和 Socket 生命周期
│  └─ useFormError.ts         表单错误自动清理
├─ socket/socket.ts           Socket.IO 客户端和共用类型导出
├─ App.css                    页面样式
└─ index.css                  全局样式
```

`shared/types.ts` 位于项目根目录的 shared 文件夹，前后端共用用户、房间、消息和 Socket.IO 事件类型。

## 未实现功能

- 页面没有匿名用户升级为正式用户的入口，虽然后端和 `api.ts` 已有对应接口。
- 没有 token 刷新、服务端注销和多设备会话管理功能。
- 没有用户资料页、头像、修改用户名或修改密码。
- 没有管理员页面，无法管理 `admin`、`banned` 等身份状态。
- 没有好友列表、好友申请、一对一私聊和用户在线状态。
- 没有房主操作，例如修改房间、踢人、转让房主和删除房间。
- 没有消息编辑、撤回、删除、回复、表情、图片或文件发送。
- 没有浏览器通知、@提醒和完整的离线消息提示。
- 没有前端自动化测试。

## 构建说明

执行 `npm run build` 后，Vite 生成 `dist/` 静态文件。部署时要保证浏览器访问页面的主机名能够访问后端 3000 端口；当前代码没有通过环境变量配置后端地址。
