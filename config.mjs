import { existsSync, readFileSync } from 'node:fs'

// .env 可选；存在则加载（覆盖进程已有的同名变量见 loadEnvFile 语义）
if (existsSync('.env')) process.loadEnvFile('.env')

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

/** @param {string | undefined} v @param {number} d */
const int = (v, d) => {
  const n = Number.parseInt(String(v ?? ''), 10)
  return Number.isFinite(n) ? n : d
}

const driver = process.env.DB_DRIVER === 'mysql' ? 'mysql' : 'pg'

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  host: process.env.HOST ?? '0.0.0.0',
  port: int(process.env.PORT, 8080),
  version: /** @type {string} */ (pkg.version),
  /** 会话签名/人机校验/后续密钥加密共用；生产环境必须显式给 */
  secret: process.env.APP_SECRET || 'dev-only-insecure-secret',
  db: {
    driver: /** @type {'pg' | 'mysql'} */ (driver),
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: int(process.env.DB_PORT, driver === 'mysql' ? 3306 : 5432),
    user: process.env.DB_USER ?? 'newerp',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME ?? 'newerp',
  },
}

/**
 * 上线门禁：生产环境捧着默认密钥跑 = 会话和人机校验形同虚设。
 * 启动时直接抦下来，比上线后才发现便宜得多。
 */
export function assertProductionConfig() {
  if (process.env.NODE_ENV !== 'production') return
  if (!process.env.APP_SECRET) {
    throw new Error('生产环境必须设置 APP_SECRET（会话签名与人机校验的 HMAC 密钥，如 openssl rand -hex 32）')
  }
}
