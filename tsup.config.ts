import { defineConfig } from 'tsup'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

function gitValue(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

const buildInfo = {
  version: JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version,
  commit: gitValue(['rev-parse', 'HEAD']),
  dirty: Boolean(gitValue(['status', '--porcelain'])),
  builtAt: new Date().toISOString(),
}

export default defineConfig({
  entry: ['src/cli/index.ts'],
  outDir: 'dist-cli',
  format: 'esm',
  target: 'node18',
  define: { __WEBUI_BUILD_INFO__: JSON.stringify(buildInfo) },
  sourcemap: true,
  clean: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
  external: ['express', 'commander'],
})
