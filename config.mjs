import { existsSync, readFileSync } from 'node:fs'

// .env 可选；存在则加载（覆盖进程已有的同名变量见 loadEnvFile 语义）
if (existsSync('.env')) process.loadEnvFile('.env')

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

/** @param {string | undefined} v @param {number} d */
const int = (v, d) => {
  const n = Number.parseInt(String(v ?? ''), 10)
  return Number.isFinite(n) ? n : d
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  host: process.env.HOST ?? '0.0.0.0',
  port: int(process.env.PORT, 8080),
  version: /** @type {string} */ (pkg.version),
}
