#!/usr/bin/env node
/**
 * dsh-deploy-public 自安装引导 —— 供「别人的 DeepSeek Harness」自行下载装配本插件。
 *
 * 用法:
 *   node install.mjs [profile名]               默认 profile: web
 *   node install.mjs web --ref v0.1.1          指定 GitHub tag/分支
 *   node install.mjs web --from-local <dir>    离线回退：从本地目录 junction 链接（网络不通时）
 *   node install.mjs web --dry-run             只演示改动，不执行
 *
 * 做了什么：
 *   1) profile package.json 添加 dependencies[github:jiahuaGitHub/dsh-deploy-public#<ref>] + dsh.bundles 注册
 *   2) 在 profile 目录跑 pnpm install（harness 装配前自动从 GitHub 下载）
 *   3) 把 SKILL.md 复制到 ~/.dsh/.agent-presets 下各 preset 的 skills/deploy-to-public/（一句话触发层）
 *   4) 提示重启 harness（或热重载）后 deploy_public 工具可用
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = '@dsh-external/dsh-deploy-public'
const REPO = 'jiahuaGitHub/dsh-deploy-public'
const DEFAULT_REF = 'v0.1.1'
const HERE = path.dirname(fileURLToPath(import.meta.url))

const args = process.argv.slice(2)
const profileName = args.find((a) => !a.startsWith('-')) ?? 'web'
const refIdx = args.indexOf('--ref')
const ref = refIdx >= 0 ? args[refIdx + 1] : DEFAULT_REF
const localIdx = args.indexOf('--from-local')
const fromLocal = localIdx >= 0 ? args[localIdx + 1] : undefined
const dryRun = args.includes('--dry-run')
const skipInstall = args.includes('--skip-install')

const profileDir = path.join(os.homedir(), '.dsh', 'profiles', profileName)
const pkgJsonPath = path.join(profileDir, 'package.json')

if (!fs.existsSync(pkgJsonPath)) {
  console.error(`✗ 未找到 profile ${profileName}: ${pkgJsonPath}`)
  console.error('  请先确认 DeepSeek Harness 的 profile 名（默认 web）')
  process.exit(1)
}

const pj = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8').replace(/^\uFEFF/, ''))
pj.dependencies = pj.dependencies ?? {}
const old = pj.dependencies[PKG]
if (fromLocal) {
  pj.dependencies[PKG] = `link:${path.resolve(fromLocal)}`
} else {
  pj.dependencies[PKG] = `github:${REPO}#${ref}`
}
pj.dsh = pj.dsh ?? {}
pj.dsh.profile = pj.dsh.profile ?? {}
pj.dsh.profile.bundles = pj.dsh.profile.bundles ?? []
if (!pj.dsh.profile.bundles.includes(PKG)) pj.dsh.profile.bundles.push(PKG)

if (!dryRun) fs.writeFileSync(pkgJsonPath, JSON.stringify(pj, null, 2) + '\n')
console.log(`[1/4] profile ${profileName} 依赖: ${old ?? '(无)'} → ${pj.dependencies[PKG]}`)
console.log(`      bundles: ${pj.dsh.profile.bundles.join(', ')}`)

// 2) pnpm install
const pnpmBin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
if (!dryRun && !skipInstall) {
  console.log('[2/4] 运行 pnpm install（从 GitHub 下载装配，网络不稳会自动重试）…')
  let ok = false
  for (let i = 1; i <= 3 && !ok; i++) {
    const r = spawnSync(pnpmBin, ['install'], { cwd: profileDir, stdio: 'inherit', env: { ...process.env } })
    if (r.status === 0) { ok = true; break }
    console.log(`      pnpm install 第 ${i} 次失败（${r.status}），重试…`)
  }
  if (!ok) {
    console.error('✗ pnpm install 失败。可能原因：github.com 不可达。')
    console.error('  回退方案：node install.mjs ' + profileName + ' --from-local <本仓库目录>')
    process.exit(1)
  }
  console.log('      ✓ 依赖已装配')
} else {
  console.log('[2/4] (dry-run' + (skipInstall ? '/skip-install' : '') + ') 跳过 pnpm install')
}

// 3) SKILL → agent presets
const presetsDir = path.join(os.homedir(), '.dsh', '.agent-presets')
const skillSrc = path.join(HERE, 'SKILL.md')
const installed = []
if (fs.existsSync(presetsDir) && fs.existsSync(skillSrc)) {
  for (const preset of fs.readdirSync(presetsDir)) {
    const target = path.join(presetsDir, preset, 'skills', 'deploy-to-public', 'SKILL.md')
    if (!dryRun) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(skillSrc, target)
    }
    installed.push(preset)
  }
}
console.log(`[3/4] SKILL 触发层 → presets: ${installed.join(', ') || '(未找到 presets)'}`)

// 4) 提示
console.log('[4/4] 完成。下一步：')
console.log('  重启 DeepSeek Harness（或热重载 web profile）后：')
console.log('  - 工具 deploy_public / deploy_status / deploy_stop 自动注册')
console.log('  - 你说「帮我把这个项目部署上网」，agent 会自动调用')
console.log('  独立 CLI（无需 DSH）：npm i -g https://github.com/' + REPO + '/releases/download/' + ref + '/dsh-external-dsh-deploy-public-' + ref.replace(/^v/, '') + '.tgz')
