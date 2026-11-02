import { close } from '../db/index.mjs'
import { createTenant } from '../svc/tenant.mjs'

const args = process.argv.slice(2)
if (args[0] !== 'create') {
  console.log(
    '用法: node cmd/tenant.mjs create --slug acme --name "ACME 集成" --email a@b.c --password 至少8位 [--display 张三]',
  )
  process.exit(1)
}

/** @type {Record<string, string>} */
const opt = {}
for (let i = 1; i < args.length; i += 2) {
  if (!args[i].startsWith('--')) break
  opt[args[i].slice(2)] = args[i + 1] ?? ''
}

try {
  const out = await createTenant({ requestId: 'cli', userId: null }, {
    slug: opt.slug,
    name: opt.name,
    email: opt.email,
    password: opt.password,
    displayName: opt.display,
  })
  console.log(`已建租户 ${out.slug}（${out.tenantId}）`)
  console.log(`owner ${out.email}（${out.userId}）`)
  console.log(`登录后访问 /t/${out.slug}/api/me`)
} catch (err) {
  console.error(/** @type {Error} */ (err).message)
  process.exitCode = 1
} finally {
  await close()
}
