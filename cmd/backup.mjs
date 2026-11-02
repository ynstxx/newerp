#!/usr/bin/env node
/**
 * 数据库备份 —— 封装 pg_dump / mysqldump。
 *
 * 用法：
 *   node cmd/backup.mjs                 # 按 DB_DRIVER 自动选工具，写到 ./backups/
 *   node cmd/backup.mjs --out /data/bk  # 覆盖输出目录
 *
 * 行为：
 *   · 优先用宿主机 PATH 里的 pg_dump / mysqldump；
 *   · 没有工具时，回退到本地 docker compose 容器（newerp-pg-1 / newerp-mysql-1）；
 *   · 只使用 execFileSync，不拼 shell 命令，避免注入；
 *   · 密码通过 PGPASSWORD / MYSQL_PWD 环境变量传给子进程，不出现在 argv 里；
 *   · 备份文件权限 0600，失败时删除半成品。
 *
 * 恢复示例（把文件名换成实际备份）：
 *
 *   # PostgreSQL
 *   PGPASSWORD='…' psql -h 127.0.0.1 -p 5433 -U newerp -d newerp \
 *     -v ON_ERROR_STOP=1 -f backups/newerp-pg-YYYYMMDD-HHMMSS-mmm.sql
 *
 *   # MySQL（备份带 --databases，文件内含 CREATE DATABASE IF NOT EXISTS / USE）
 *   MYSQL_PWD='…' mysql -h 127.0.0.1 -P 3308 -u newerp \
 *     < backups/newerp-mysql-YYYYMMDD-HHMMSS-mmm.sql
 *
 * 注意：恢复会覆盖目标库；生产恢复前先在临时库演练。迁移没有 down，回滚只能靠备份。
 */
import { execFileSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { config } from '../config.mjs'

/** @typedef {'pg' | 'mysql'} Driver */

const TOOL = /** @type {Record<Driver, string>} */ ({ pg: 'pg_dump', mysql: 'mysqldump' })
const CONTAINER = /** @type {Record<Driver, string>} */ ({ pg: 'newerp-pg-1', mysql: 'newerp-mysql-1' })

const USAGE = `用法:
  node cmd/backup.mjs [--out <目录>]

环境变量（也可写在 .env）:
  DB_DRIVER=pg|mysql  DB_HOST  DB_PORT  DB_USER  DB_PASSWORD  DB_NAME

说明:
  宿主机没有 pg_dump / mysqldump 时，会尝试 docker exec 到
  newerp-pg-1 / newerp-mysql-1 容器里执行。`

/**
 * @param {string[]} argv
 * @returns {{ outDir: string, help: boolean }}
 */
function parseArgs(argv) {
  let outDir = 'backups'
  let help = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') {
      help = true
    } else if (a === '--out') {
      const v = argv[++i]
      if (!v) throw new Error('--out 需要一个目录参数')
      outDir = v
    } else if (a.startsWith('--out=')) {
      outDir = a.slice('--out='.length)
      if (!outDir) throw new Error('--out 需要一个目录参数')
    } else {
      throw new Error(`未知参数 ${a}\n\n${USAGE}`)
    }
  }
  return { outDir, help }
}

/** 宿主机 PATH 里有没有这个命令（不经过 shell）。 @param {string} cmd */
function hasTool(cmd) {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** 容器是否正在运行。 @param {string} name */
function containerRunning(name) {
  try {
    const out = execFileSync('docker', ['inspect', '--format', '{{.State.Running}}', name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.trim() === 'true'
  } catch {
    return false
  }
}

/** 本地工具的连接参数。 @param {Driver} driver */
function localArgs(driver) {
  const db = config.db
  if (driver === 'pg') {
    return [
      '--no-owner',
      '--no-privileges',
      '-h',
      db.host,
      '-p',
      String(db.port),
      '-U',
      db.user,
      '-d',
      db.database,
    ]
  }
  return [
    '--single-transaction',
    '--quick',
    '--no-tablespaces',
    '--default-character-set=utf8mb4',
    '-h',
    db.host,
    '-P',
    String(db.port),
    '-u',
    db.user,
    '--databases',
    db.database,
  ]
}

/**
 * 容器内工具的连接参数：走容器本地 socket，避免把宿主机映射端口（5433/3308）带进去。
 * 密码仍由 docker exec -e 从当前进程环境透传，不写在 argv。
 * @param {Driver} driver
 */
function dockerArgs(driver) {
  const db = config.db
  if (driver === 'pg') {
    return [
      'exec',
      '-e',
      'PGPASSWORD',
      CONTAINER.pg,
      'pg_dump',
      '--no-owner',
      '--no-privileges',
      '-U',
      db.user,
      '-d',
      db.database,
    ]
  }
  return [
    'exec',
    '-e',
    'MYSQL_PWD',
    CONTAINER.mysql,
    'mysqldump',
    '--single-transaction',
    '--quick',
    '--no-tablespaces',
    '--default-character-set=utf8mb4',
    '-u',
    db.user,
    '--databases',
    db.database,
  ]
}

/** @param {Date} d */
function stamp(d) {
  const p = (/** @type {number} */ n, /** @type {number} */ w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`
}

/** @param {number} bytes */
function human(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function main() {
  const { outDir, help } = parseArgs(process.argv.slice(2))
  if (help) {
    console.log(USAGE)
    return
  }

  const db = config.db
  const driver = /** @type {Driver} */ (db.driver)
  const tool = TOOL[driver]

  let cmd = tool
  let args = localArgs(driver)
  let how = tool
  if (!hasTool(tool)) {
    const box = CONTAINER[driver]
    if (!containerRunning(box)) {
      const hint =
        driver === 'pg'
          ? '请安装 postgresql-client（提供 pg_dump），或执行 docker compose up -d pg。'
          : '请安装 mysql-client（提供 mysqldump），或执行 docker compose --profile mysql up -d。'
      throw new Error(
        `未找到可用的 ${tool}：宿主机 PATH 中没有，容器 ${box} 也未运行。\n${hint}`,
      )
    }
    cmd = 'docker'
    args = dockerArgs(driver)
    how = `docker exec ${box} ${tool}`
  }

  const dir = resolve(outDir)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `newerp-${driver}-${stamp(new Date())}.sql`)

  /** 密码只走环境变量；docker exec -e 会把同名环境变量透传进容器。 */
  const env = { ...process.env }
  if (driver === 'pg') env.PGPASSWORD = db.password
  else env.MYSQL_PWD = db.password

  /** @type {number} */
  let fd = -1
  try {
    fd = openSync(file, 'wx', 0o600)
    execFileSync(cmd, args, { env, stdio: ['ignore', fd, 'inherit'] })
  } catch (err) {
    if (fd >= 0) {
      try {
        closeSync(fd)
      } catch {
        // 忽略关闭失败，下面统一删除半成品
      }
      fd = -1
    }
    rmSync(file, { force: true })
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`${how} 执行失败：${msg}`)
  } finally {
    if (fd >= 0) closeSync(fd)
  }

  const { size } = statSync(file)
  console.log(`备份完成（${driver}，${how}）`)
  console.log(`文件: ${file}`)
  console.log(`大小: ${human(size)}（${size} bytes）`)
  console.log('')
  if (driver === 'pg') {
    console.log(
      `恢复: PGPASSWORD='…' psql -h ${db.host} -p ${db.port} -U ${db.user} -d ${db.database} -v ON_ERROR_STOP=1 -f ${file}`,
    )
  } else {
    console.log(`恢复: MYSQL_PWD='…' mysql -h ${db.host} -P ${db.port} -u ${db.user} < ${file}`)
  }
}

try {
  main()
} catch (err) {
  console.error(`备份失败: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
}
