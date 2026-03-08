# DO 控制面板

支持通过 DigitalOcean API 管理 Droplet：
- 查看当前机器
- 查看 Available Credits（每 15 秒自动刷新）
- 创建机器（支持命名）
- 重命名机器
- 重装系统
- 删除机器

默认创建参数：
- Region: 优先 Atlanta（自动识别，可用时使用）
- Size: 2 GB / 2 Intel CPUs（优先 intel slug）
- OS: Ubuntu（自动选择最新可用 Ubuntu x64）
- SSH Key: 默认使用 `DO_DEFAULT_SSH_PUBLIC_KEY`（若账户不存在会自动导入）

## 启动

```bash
cp .env.example .env
# 填写 DO_API_TOKEN 和 DO_DEFAULT_SSH_PUBLIC_KEY
export DO_API_TOKEN=your_digitalocean_api_token
export DO_DEFAULT_SSH_PUBLIC_KEY='ssh-ed25519 AAAA...'
npm start
```

浏览器访问 `http://localhost:3000`

## Docker 启动

1. 在项目根目录创建 `.env`（可直接复制 `.env.example`）并填写：

```bash
DO_API_TOKEN=your_digitalocean_api_token
DO_DEFAULT_SSH_PUBLIC_KEY=ssh-ed25519 AAAA...
PORT=3000
```

2. 启动容器：

```bash
docker compose up -d --build
```

3. 访问：

`http://localhost:3000`

4. 停止：

```bash
docker compose down
```

## API

- `GET /api/droplets`：查询当前机器
- `GET /api/credits`：查询 Available Credits
- `Available Credits` 优先读取 DigitalOcean 直接返回的 credits 字段；若未提供，则按 GitHub Student Pack 默认 `$200` 和 invoice summary/preview 已抵扣 credits 估算
- 可通过环境变量 `DO_STUDENT_PACK_INITIAL_CREDITS` 覆盖默认初始额度
- `POST /api/droplets`：创建机器
  - body: `{ "name": "web-1", "region": "atl1?", "size": "s-2vcpu-2gb-intel?", "image": "ubuntu-24-04-x64?", "sshKeyFingerprint": "fingerprint?" }`
  - `region/size/image/sshKeyFingerprint` 可省略，省略时用默认自动解析
- `PATCH /api/droplets/:id/rename`：重命名机器
  - body: `{ "name": "new-name" }`
- `POST /api/droplets/:id/rebuild`：重装系统
  - body: `{ "image": "ubuntu-24-04-x64?" }`
  - `image` 可省略，省略时自动使用默认 Ubuntu 镜像
- `DELETE /api/droplets/:id`：删除机器
