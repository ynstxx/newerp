import { close } from '../db/index.mjs'
import * as users from '../store/user.mjs'

const [cmd, email] = process.argv.slice(2)
const ctx = { requestId: 'cli', userId: null }

try {
  if (cmd === 'pending') {
    const rows = await users.pending(ctx)
    if (!rows.length) console.log('没有待放行的账号')
    for (const r of rows) console.log(`${r.email}\t${r.display_name}\t${r.created_at}`)
  } else if (cmd === 'approve' && email) {
    const n = await users.setStatus(ctx, email.toLowerCase(), 'active')
    console.log(n ? `已放行 ${email}` : `没找到 ${email}`)
    if (!n) process.exitCode = 1
  } else if (cmd === 'disable' && email) {
    const n = await users.setStatus(ctx, email.toLowerCase(), 'disabled')
    console.log(n ? `已停用 ${email}` : `没找到 ${email}`)
    if (!n) process.exitCode = 1
  } else {
    console.log('用法:\n  node cmd/user.mjs pending\n  node cmd/user.mjs approve <email>\n  node cmd/user.mjs disable <email>')
    process.exitCode = 1
  }
} catch (err) {
  console.error(/** @type {Error} */ (err).message)
  process.exitCode = 1
} finally {
  await close()
}
