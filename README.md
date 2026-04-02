# DO 控制面板

基于 Spring Boot 的 DigitalOcean Droplet 控制面板，支持：
- 查看当前机器
- 查看 Available Credits（每 15 秒自动刷新）
- 创建机器（支持命名）
- 重命名机器
- 保存标签
- 重装系统
- 删除机器
- 按标签批量删除机器

默认创建参数：
- Region: 可选 `sfo3` / `sgp1` / `blr1`，默认 `sgp1`
- Size: 经典型号预置列表（可搜索），默认 `s-1vcpu-1gb`
  - `$4/mo ($0.006/hour)`: `s-1vcpu-512mb-10gb` (512 MB / 1 CPU, 10 GB SSD, 500 GB transfer)
  - `$6/mo ($0.009/hour)`: `s-1vcpu-1gb` (1 GB / 1 CPU, 25 GB SSD, 1000 GB transfer)
  - `$12/mo ($0.018/hour)`: `s-1vcpu-2gb` (2 GB / 1 CPU, 50 GB SSD, 2 TB transfer)
  - `$18/mo ($0.027/hour)`: `s-2vcpu-2gb` (2 GB / 2 CPUs, 60 GB SSD, 3 TB transfer)
  - `$24/mo ($0.036/hour)`: `s-2vcpu-4gb` (4 GB / 2 CPUs, 80 GB SSD, 4 TB transfer)
  - `$48/mo ($0.071/hour)`: `s-4vcpu-8gb` (8 GB / 4 CPUs, 160 GB SSD, 5 TB transfer)
- OS: Ubuntu 22.04 (`ubuntu-22-04-x64`)
- SSH Key: 默认使用 `DO_DEFAULT_SSH_PUBLIC_KEY`（若账户不存在会自动导入）

## 启动

### 方式一：本地启动（需要 Java 21 + Maven）

```bash
cp .env.example .env
# 填写 DO_API_TOKEN 和 DO_DEFAULT_SSH_PUBLIC_KEY
export DO_API_TOKEN=your_digitalocean_api_token
export DO_DEFAULT_SSH_PUBLIC_KEY='ssh-ed25519 AAAA...'
export PORT=3000
mvn spring-boot:run
```

浏览器访问 `http://localhost:3000`

### 方式二：Docker 启动

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

Git 推送相关脚本已经从本项目拆出，放在上级目录的 `/root/git-tools`。

## API

- `GET /api/health`：健康检查
- `GET /api/droplets`：查询当前机器
- `GET /api/credits`：查询 Available Credits
- `GET /api/balance`：已废弃（返回 410，提示使用 `/api/credits`）
- `GET /api/sizes/popular?q=关键词&region=sgp1`：查询经典型号（按 region 过滤，支持关键词过滤）
- `POST /api/droplets`：创建机器
  - body: `{ "name": "web-1", "region": "sgp1", "size": "s-1vcpu-1gb", "tags": ["web"], "sshKeyFingerprint": "fingerprint?" }`
  - `region` 只允许 `sfo3` / `sgp1` / `blr1`，省略时默认 `sgp1`
  - `size` 可选，若省略默认 `s-1vcpu-1gb`；仅允许经典型号列表返回的 slug
  - 镜像固定为 `ubuntu-22-04-x64`
  - `sshKeyFingerprint` 可省略，省略时使用默认 SSH key
- `PATCH /api/droplets/:id/rename`：重命名机器
  - body: `{ "name": "new-name" }`
- `PATCH /api/droplets/:id/tags`：覆盖保存标签
  - body: `{ "tags": ["web", "prod"] }`
- `POST /api/droplets/:id/rebuild`：重装系统
  - body: `{}` 或空 body
  - 重装镜像固定使用 `ubuntu-22-04-x64`
- `DELETE /api/droplets/:id`：删除机器
- `DELETE /api/droplets/by-tag/:tag`：按标签批量删除

### Credits 计算逻辑

- 优先读取 DigitalOcean balance 响应中的直接 credits 字段
- 若未提供，则按 GitHub Student Pack 默认 `$200` 和 invoice summary/preview 的已抵扣 credits 估算
- 可通过环境变量 `DO_STUDENT_PACK_INITIAL_CREDITS` 覆盖默认初始额度
