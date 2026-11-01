import { check, gen, up } from '../db/migrate.mjs'

const [cmd, arg] = process.argv.slice(2)

try {
  if (cmd === 'gen') {
    if (!arg) throw new Error('用法: node cmd/migrate.mjs gen 0002_add_xxx')
    await gen(arg)
  } else if (cmd === 'up') {
    await up()
  } else if (cmd === 'check') {
    process.exitCode = (await check()) ? 1 : 0
  } else {
    console.log('用法:\n  node cmd/migrate.mjs gen <name>\n  node cmd/migrate.mjs up\n  node cmd/migrate.mjs check')
    process.exitCode = 1
  }
} catch (err) {
  console.error(/** @type {Error} */ (err).message)
  process.exitCode = 1
}
