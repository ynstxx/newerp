# 升级指南

本文适用于 `v1`（`main` 分支）的自托管部署。云平台部署由运营方执行同一套步骤。

> **先备份，再升级。** 迁移是单向的，没有 `down`；回滚只能靠备份恢复。
> 备份工具：`cmd/backup.mjs`（见第 2 节）。

---

## 1. 升级步骤

在应用目录执行：

```bash
# 1) 备份当前数据库（默认写到 backups/）
node cmd/backup.mjs

# 2) 拉取新代码（按你的发布方式二选一）
git fetch --all
git checkout main && git pull --ff-only
# 或者：git checkout <release-tag>

# 3) 安装依赖（运行时依赖仍只有 pg / mysql2）
npm i

# 4) 应用迁移（幂等；已应用的版本会跳过）
node cmd/migrate.mjs up

# 5) 结构漂移检查（必须退出码 0）
node cmd/migrate.mjs check

# 6) 重启应用进程（systemd / pm2 / 容器 / 前台 node 都行）
node cmd/server.mjs
```

升级期间注意：

- **不要修改 `APP_SECRET`**。AI / 通知 / 集成密钥都由它派生，换了之后旧密文全部解不开，只能重新录入。
- 迁移器带 advisory lock，多实例同时启动也只会有一个实例执行迁移；但仍建议**先迁移、再放开流量**。
- 本仓库的 `cmd/server.mjs` **不会自动跑迁移**，必须显式执行 `node cmd/migrate.mjs up`。

---

## 2. 迁移是单向的（硬约束）

`cmd/migrate.mjs` 只有三个命令：

| 命令 | 作用 |
|---|---|
| `gen <name>` | 根据 `schema/*.mjs` 生成 PG / MySQL 两份 SQL |
| `up` | 按文件名顺序应用**尚未应用**的迁移 |
| `check` | 比对声明结构与实际库结构，漂移返回非零 |

**没有 `down`，没有自动回滚。** 已应用的迁移文件带 checksum，改一个字节都会被拒绝。
因此：

- 升级前必须有一份**可恢复的备份**；否则迁移失败时只能手工修库。
- 回滚 = 用升级前的备份恢复数据库，再把代码切回旧 commit。
- 恢复会覆盖目标库。先在临时库演练，确认备份可读、版本匹配，再动生产库。

### PostgreSQL 恢复

```bash
# 先建空库（或确认要覆盖的库）
createdb -h 127.0.0.1 -p 5433 -U newerp newerp_restore

# 恢复（PGPASSWORD 走环境变量，不要写进命令行）
PGPASSWORD=你的密码 psql \
  -h 127.0.0.1 -p 5433 -U newerp -d newerp_restore \
  -v ON_ERROR_STOP=1 \
  -f backups/newerp-pg-YYYYMMDD-HHMMSS-mmm.sql
```

### MySQL 恢复

```bash
# 备份文件里带了 CREATE DATABASE IF NOT EXISTS / USE，直接导入即可
MYSQL_PWD=你的密码 mysql \
  -h 127.0.0.1 -P 3308 -u newerp \
  < backups/newerp-mysql-YYYYMMDD-HHMMSS-mmm.sql
```

恢复后把应用的 `DB_NAME` 指回恢复库（或把恢复库改名为原库名），再启动应用。

---

## 3. 双库升级命令

一次部署只用一种数据库，按 `DB_DRIVER` 执行其中一段。两段都跑一遍只适合本地/CI 验证。

### PostgreSQL

```bash
export NODE_ENV=production
export DB_DRIVER=pg DB_HOST=127.0.0.1 DB_PORT=5433 \
       DB_USER=newerp DB_PASSWORD='…' DB_NAME=newerp

node cmd/backup.mjs
npm i
node cmd/migrate.mjs up
node cmd/migrate.mjs check
node --test
```

### MySQL

```bash
export NODE_ENV=production
export DB_DRIVER=mysql DB_HOST=127.0.0.1 DB_PORT=3308 \
       DB_USER=newerp DB_PASSWORD='…' DB_NAME=newerp

node cmd/backup.mjs
npm i
node cmd/migrate.mjs up
node cmd/migrate.mjs check
node --test
```

> `docker-compose.yml` 里 PG 映射到宿主机 `5433`、MySQL 映射到 `3308`；应用进程在宿主机运行时用这两个端口。
> 如果应用也在容器里，请把 `DB_HOST` / `DB_PORT` 改成容器网络内的地址和默认端口（`5432` / `3306`）。

---

## 4. 如何验证升级成功

按顺序做，任何一步失败都不要继续放流量：

1. **健康检查**——`db` 必须是 `up`，`ok` 必须是 `true`：

   ```bash
   curl -s localhost:8080/healthz
   # {"ok":true,"db":"up","version":"…","env":"production","uptime":…,"requestId":"…"}
   ```

2. **结构检查**——退出码 0，输出“结构与声明一致”：

   ```bash
   node cmd/migrate.mjs check
   ```

3. **迁移幂等**——再跑一次 `up`，应输出“无待应用迁移”：

   ```bash
   node cmd/migrate.mjs up
   ```

4. **测试**——用与生产相同的 `DB_DRIVER` 跑一遍。**建议先把备份恢复到临时库再跑**，否则测试会在生产库里建测试租户/数据：

   ```bash
   DB_NAME=newerp_restore node --test
   ```

5. **冒烟**：登录、打开一个列表、创建一条测试数据、退出登录；确认审计表有新行。

---

## 5. 已知会踩的坑

| 坑 | 说明 | 处理 |
|---|---|---|
| `ADD COLUMN ... NOT NULL` 没有默认值 | 表里已有数据时，两库都会失败 | 在 `schema/*.mjs` 里给 `default`（生成器支持），或改成先加可空列、回填、再收紧 |
| 手改了已应用的迁移文件 | checksum 不匹配，`up` 直接报“已被修改但已应用过” | 不要改历史文件；新增 `000N+1_*.sql` |
| MySQL DDL 非事务 | 迁移中途失败会留下“半迁移”状态，无法自动回滚 | 用升级前备份恢复；恢复后重跑 `up` / `check` |
| 换了 `APP_SECRET` | 会话失效是小事，AI / 通知 / 集成密钥全部解不开 | 保持 `APP_SECRET` 不变；必须换时预留重新录入密钥的窗口 |
| 直接改数据库结构 | `check` 报漂移，后续迁移可能对不上 | 只通过 `schema/*.mjs` + `gen` 改结构 |
| 备份目录没写权限 | `node cmd/backup.mjs` 失败，升级没有退路 | 先修权限，或用 `--out /path` 指到可写目录 |
| 备份文件与数据库版本不匹配 | 用 MySQL 8.0 的 dump 往 5.7 导，或反过来 | 恢复目标保持同大版本；跨版本先测试 |
| 多个实例同时升级 | 迁移有 advisory lock，但应用可能在新表建好前就开始服务 | 先停旧实例 → 迁移 → 验证 → 再启动新实例 |

更多已知功能缺口见 [`docs/OPEN-ISSUES.md`](OPEN-ISSUES.md)。
