import { close } from '../db/index.mjs'
import { DEFAULTS, all, get, set } from '../svc/settings.mjs'

const [cmd, key, value] = process.argv.slice(2)
const ctx = { requestId: 'cli', userId: null }

try {
  if (cmd === 'list') {
    const data = await all(ctx)
    for (const k of Object.keys(DEFAULTS)) console.log(`${k} = ${data[k]}`)
  } else if (cmd === 'get' && key) {
    console.log(await get(ctx, key))
  } else if (cmd === 'set' && key && value !== undefined) {
    await set(ctx, key, value)
    console.log(`${key} = ${value}（本进程立即生效，其他实例最长 30 秒）`)
  } else {
    console.log('用法:\n  node cmd/settings.mjs list\n  node cmd/settings.mjs get <key>\n  node cmd/settings.mjs set <key> <value>')
    console.log(`\n可改的键:\n  ${Object.keys(DEFAULTS).join('\n  ')}`)
    process.exitCode = 1
  }
} catch (err) {
  console.error(/** @type {Error} */ (err).message)
  process.exitCode = 1
} finally {
  await close()
}
