import { execFile } from 'node:child_process'
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)

export function readTopLevelString(config, key) {
  const top = config.split(/^\s*\[/m, 1)[0]
  const value = top.match(new RegExp(`^\\s*${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|'[^']*')\\s*(?:#.*)?$`, 'm'))?.[1]
  if (!value) return null
  return value.startsWith('"') ? JSON.parse(value) : value.slice(1, -1)
}

function setTopLevelString(config, key, value) {
  const tableIndex = config.search(/^\s*\[/m)
  const top = tableIndex < 0 ? config : config.slice(0, tableIndex)
  const rest = tableIndex < 0 ? '' : config.slice(tableIndex)
  const assignment = `${key} = ${JSON.stringify(value)}`
  const pattern = new RegExp(`^\\s*${key}\\s*=.*$`, 'm')
  return (pattern.test(top) ? top.replace(pattern, assignment) : `${assignment}\n${top}`) + rest
}

export function prepareAcceptanceConfig(config, catalog, bundled, targetHome, requestedModels) {
  if (!Array.isArray(catalog.models) || !Array.isArray(bundled.models)) throw new Error('模型目录必须包含 models 数组。')
  const models = [...catalog.models]
  const added = []
  for (const id of requestedModels) {
    if (models.some(model => model.slug === id)) continue
    const model = bundled.models.find(model => model.slug === id)
    if (!model) throw new Error(`指定 CLI 的随附目录中没有模型：${id}`)
    models.push(model)
    added.push(id)
  }
  let nextConfig = config
  for (const [key, value] of Object.entries({ model_catalog_json: join(targetHome, 'models.acceptance.json'), sqlite_home: join(targetHome, 'sqlite'), log_dir: join(targetHome, 'logs') })) {
    nextConfig = setTopLevelString(nextConfig, key, value)
  }
  return { config: nextConfig, catalog: { ...catalog, models }, added }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log('node scripts/prepare-codex-acceptance.mjs --source-home PATH --target-home NEW_PATH --codex-command PINNED_BINARY [--add-model MODEL] [--copy-auth] [--apply]\n默认只预览；目标必须尚不存在；仅复制配置、显式选择的认证和模型目录，不复制会话、数据库或队列。')
    return
  }
  const value = key => {
    const index = args.indexOf(key)
    return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : ''
  }
  if (!value('--source-home') || !value('--target-home') || !value('--codex-command')) throw new Error('必须明确指定源目录、全新测试目录和固定 CLI。')
  const sourceHome = resolve(value('--source-home'))
  const targetHome = resolve(value('--target-home'))
  if (sourceHome === targetHome || targetHome.startsWith(sourceHome + '/')) throw new Error('测试目录必须独立于源 CODEX_HOME。')
  try {
    await access(targetHome)
    throw new Error('测试目录已经存在；不会覆盖配置或历史。')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const command = resolve(value('--codex-command'))
  const temporaryHome = await mkdtemp(join(tmpdir(), 'codex-catalog-preview-'))
  let stage = ''
  try {
    const options = { env: { ...process.env, CODEX_HOME: temporaryHome }, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }
    const version = (await execute(command, ['--version'], options)).stdout.trim()
    const bundled = JSON.parse((await execute(command, ['debug', 'models', '--bundled'], options)).stdout)
    const config = await readFile(join(sourceHome, 'config.toml'), 'utf8')
    const catalogPath = readTopLevelString(config, 'model_catalog_json')
    const catalog = catalogPath ? JSON.parse(await readFile(resolve(sourceHome, catalogPath), 'utf8')) : bundled
    const requestedModels = value('--add-model').split(',').map(model => model.trim()).filter(Boolean)
    const prepared = prepareAcceptanceConfig(config, catalog, bundled, targetHome, requestedModels)
    const report = { mode: args.includes('--apply') ? 'apply' : 'preview', sourceHome, targetHome, command, version, addedModels: prepared.added, retainedModelCount: catalog.models.length, totalModelCount: prepared.catalog.models.length, copyAuth: args.includes('--copy-auth'), copiesHistory: false, globalConfigChanged: false }
    if (args.includes('--apply')) {
      await mkdir(dirname(targetHome), { recursive: true, mode: 0o700 })
      stage = await mkdtemp(join(dirname(targetHome), '.acceptance-stage-'))
      await chmod(stage, 0o700)
      await writeFile(join(stage, 'config.toml'), prepared.config, { mode: 0o600 })
      await writeFile(join(stage, 'models.acceptance.json'), JSON.stringify(prepared.catalog, null, 2) + '\n', { mode: 0o600 })
      if (args.includes('--copy-auth')) {
        await copyFile(join(sourceHome, 'auth.json'), join(stage, 'auth.json'))
        await chmod(join(stage, 'auth.json'), 0o600)
      }
      await writeFile(join(stage, 'acceptance-manifest.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
      await rename(stage, targetHome)
      stage = ''
    }
    console.log(JSON.stringify(report, null, 2))
  } finally {
    await rm(temporaryHome, { recursive: true, force: true })
    if (stage) await rm(stage, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
