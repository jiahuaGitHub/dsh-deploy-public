#!/usr/bin/env node
/**
 * dsh-deploy-public CLI —— 一条命令把本地项目部署到公网，无需 DeepSeek Harness。
 *
 *   dsh-deploy doctor [dir]                       环境自检
 *   dsh-deploy tunnel <dir> [--port N] [--start-cmd "…"]   临时公网链接（零账号）
 *   dsh-deploy permanent <dir> [--repo NAME] [--start-cmd "…"] [--include-dist] [--push-existing] [--private] [--yes]  GitHub+Render 永久部署
 *   dsh-deploy status                             查看运行中的部署
 *   dsh-deploy stop [all|server|tunnel]           停止部署
 *
 * 安装：npm i -g <GitHub Release tgz>（本包未发布到 npm registry，勿用 npm i -g dsh-deploy-public）
 */
import path from 'node:path'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import {
  sleep, readStartScript, defaultPortOf, waitHealthy, waitTunnelUrl, verifyPublic,
  ensureGhAuthBlocking, publishToGithub, doctor,
  STATE_DIR, STATE_FILE, loadState, saveState, clearState, pidAlive, killPidTree,
  spawnDetached, tailFile,
} from './engine.js'

const args = process.argv.slice(2)
const cmd = args[0] ?? 'help'

function flagValue(rest: string[], name: string): string | undefined {
  const i = rest.findIndex((a) => a === name)
  if (i >= 0 && rest[i + 1]) return rest[i + 1]
  const eq = rest.find((a) => a.startsWith(name + '='))
  return eq ? eq.slice(name.length + 1) : undefined
}

function parseCommon(rest: string[]): { dir: string; port?: number; startCmd?: string } {
  const dir = rest.find((a) => !a.startsWith('-')) ?? ''
  if (!dir || !existsSync(dir)) {
    console.error('✗ 需要项目目录（绝对路径）：dsh-deploy tunnel D:\\path\\to\\project')
    process.exit(1)
  }
  const portRaw = flagValue(rest, '--port')
  let port: number | undefined
  if (portRaw !== undefined) {
    port = Number(portRaw)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(`✗ --port 必须是 1-65535 的整数，收到: ${portRaw}`)
      process.exit(1)
    }
  }
  return { dir, port, startCmd: flagValue(rest, '--start-cmd') }
}

async function cmdTunnel(rest: string[]): Promise<void> {
  const { dir, port, startCmd } = parseCommon(rest)
  const state = loadState()
  const portN = port ?? (state && state.projectDir === dir ? state.port : undefined) ?? defaultPortOf(dir, 4173)
  // 服务与隧道都活着 → 直接复用（用 state 记录的端口，避免参数漂移）
  if (state && state.projectDir === dir && pidAlive(state.server.pid) && state.tunnel && pidAlive(state.tunnel.pid)) {
    console.log(`已存在部署：${state.tunnel.url}（dsh-deploy stop all 可停掉）`)
    return
  }
  const scripts = readStartScript(dir)
  const cmdLine = startCmd ?? scripts.start ?? scripts.dev
  if (!cmdLine) {
    console.error('✗ 未找到启动命令：请在 package.json 配 start/dev 脚本，或用 --start-cmd 指定')
    process.exit(1)
  }
  const logDir = path.join(STATE_DIR, 'logs')
  let serverPid: number
  if (state && state.projectDir === dir && pidAlive(state.server.pid)) {
    serverPid = state.server.pid
    console.log(`[1/4] 复用已运行服务 pid=${serverPid}`)
  } else {
    // 透明化：明确展示将要执行的命令（防恶意项目脚本被静默执行）
    console.log(`[1/4] 启动命令: ${cmdLine}`)
    const serverLog = path.join(logDir, 'server.log')
    const serverChild = spawnDetached(cmdLine, dir, serverLog, { PORT: String(portN) })
    serverPid = serverChild.pid ?? 0
    if (!serverPid) { console.error('✗ 服务启动失败'); process.exit(1) }
    saveState({ projectDir: dir, port: portN, server: { pid: serverPid, startedAt: Date.now() } })
    console.log(`      服务已启动 pid=${serverPid} 日志=${serverLog}`)
  }

  console.log('[2/4] 本地健康检查中…')
  const health = await waitHealthy(portN)
  if (!health.ok) {
    console.error('✗ 健康检查失败: ' + health.detail + '\n服务日志尾部:\n' + tailFile(path.join(logDir, 'server.log'), 15))
    process.exit(1)
  }
  console.log(`    通过 ${health.detail}`)

  console.log('[3/4] 建立 cloudflared 隧道…')
  const tunnelLog = path.join(logDir, 'tunnel.log')
  const tunnelChild = spawnDetached(`cloudflared tunnel --url http://127.0.0.1:${portN} --no-autoupdate`, dir, tunnelLog)
  const tunnelPid = tunnelChild.pid
  const url = await waitTunnelUrl(() => tailFile(tunnelLog, 200))
  if (!url) {
    console.error('✗ 未获取到隧道 URL\n隧道日志尾部:\n' + tailFile(tunnelLog, 20))
    process.exit(1)
  }
  const st = loadState() ?? { projectDir: dir, port: portN, server: { pid: serverPid, startedAt: Date.now() } }
  st.tunnel = { pid: tunnelPid!, url }
  saveState(st)
  console.log(`    ${url}`)

  console.log('[4/4] 公网验证中…')
  const v = await verifyPublic(url + '/api/health')
  console.log(`    ${v.detail}`)
  if (v.ok || v.directOk) {
    console.log('\n✅ 公网地址: ' + url)
  } else {
    console.log('\n⚠️ 隧道已建立但本机 DNS 无法解析 trycloudflare 子域名（本机探测结果，不证明公网不可达）。')
    console.log('   解决：① DNS 改公共（8.8.8.8/223.5.5.5）② 浏览器开「安全 DNS」③ 手机流量访问')
    console.log('   地址: ' + url)
  }
  console.log('\n管理：dsh-deploy status | dsh-deploy stop all')
}

/** 交互确认（TTY）；非 TTY 必须 --yes，杜绝无确认的公开发布 */
function confirmOrExit(question: string, yes: boolean): Promise<void> {
  return new Promise((resolve) => {
    if (yes) { resolve(); return }
    if (!process.stdin.isTTY) {
      console.error(`✗ 非交互环境需显式 --yes 确认：${question}`)
      process.exit(1)
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question + ' [y/N] ', (a) => {
      rl.close()
      if (!/^y/i.test(a)) { console.error('已取消'); process.exit(1) }
      resolve()
    })
  })
}

async function cmdPermanent(rest: string[]): Promise<void> {
  const { dir, startCmd } = parseCommon(rest)
  const repo = flagValue(rest, '--repo') ?? path.basename(dir).replace(/[^a-zA-Z0-9._-]/g, '-')
  const includeDist = rest.includes('--include-dist')
  const pushExisting = rest.includes('--push-existing')
  const yes = rest.includes('--yes')
  const visibility = rest.includes('--private') ? 'private' : 'public'
  const scripts = readStartScript(dir)
  const cmdLine = startCmd ?? scripts.start ?? ''

  console.log('[1/4] GitHub 授权检查…')
  const auth = await ensureGhAuthBlocking()
  if (!auth.ok) {
    console.error('✗ GitHub 授权失败: ' + auth.detail)
    process.exit(1)
  }
  console.log('    ✓ ' + auth.detail)

  if (visibility === 'public') {
    await confirmOrExit(`即将创建/推送【公开】仓库 ${repo}（${cmdLine || '默认启动命令'}）。继续？`, yes)
  }
  console.log(`[2/4] 发布准备（仓库 ${repo}，${visibility}${includeDist ? '，含 dist/' : ''}${pushExisting ? '，允许既有 origin' : ''}）…`)

  console.log('[3/4] 建仓/提交/推送（网络不稳自动重试）…')
  const result = await publishToGithub(dir, {
    repoName: repo,
    startCommand: cmdLine || undefined,
    includeDist,
    allowExistingRemote: pushExisting,
    visibility,
  })
  if (result.status !== 'published') {
    console.error('✗ 发布失败: ' + JSON.stringify(result, null, 2))
    process.exit(1)
  }
  console.log('[4/4] 完成')
  console.log(JSON.stringify(result, null, 2))
}

function cmdStatus(): void {
  const st = loadState()
  if (!st) { console.log('无部署记录（state 文件: ' + STATE_FILE + '）'); return }
  const serverAlive = pidAlive(st.server.pid)
  const tunnelAlive = st.tunnel ? pidAlive(st.tunnel.pid) : false
  console.log(JSON.stringify({
    projectDir: st.projectDir,
    port: st.port,
    server: { pid: st.server.pid, alive: serverAlive },
    tunnel: st.tunnel ? { pid: st.tunnel.pid, alive: tunnelAlive, url: st.tunnel.url } : null,
    serverLog: tailFile(path.join(STATE_DIR, 'logs', 'server.log'), 5),
    tunnelLog: tailFile(path.join(STATE_DIR, 'logs', 'tunnel.log'), 5),
  }, null, 2))
}

function cmdStop(rest: string[]): void {
  const st = loadState()
  if (!st) { console.log('无部署记录'); return }
  const target = rest[0] ?? 'all'
  if (target === 'all' || target === 'server') {
    // 停 server 时隧道一并停（隧道指向的服务已死，留着无意义）
    const killed = ['server ' + killPidTree(st.server.pid)]
    if (st.tunnel) killed.push('tunnel ' + killPidTree(st.tunnel.pid))
    clearState()
    console.log('已停止: ' + killed.join('; '))
  } else if (target === 'tunnel' && st.tunnel) {
    const r = killPidTree(st.tunnel.pid)
    st.tunnel = undefined
    saveState(st)
    console.log('已停止: tunnel ' + r + '（server 仍在运行，可用 dsh-deploy stop all 一并停止）')
  } else {
    console.log('无匹配的停止目标')
  }
}

async function cmdDoctor(rest: string[]): Promise<void> {
  const dir = rest.find((a) => !a.startsWith('-'))
  const r = await doctor(dir)
  for (const c of r.checks) {
    console.log(`${c.pass ? '✓' : '✗'} ${c.name.padEnd(12)} ${c.detail}`)
  }
  console.log(r.ok ? '\n✅ 环境就绪，可以部署' : '\n⚠️ 有未通过项，按上面提示安装/配置后重试（doctor 只检查，不自动安装）')
}

function help(): void {
  console.log(`dsh-deploy-public — 一条命令把本地项目部署到公网

用法:
  dsh-deploy doctor [dir]                        环境自检（只检查，不自动安装）
  dsh-deploy tunnel <dir> [--port N] [--start-cmd "…"]   临时公网链接（零账号）
  dsh-deploy permanent <dir> [--repo NAME] [--start-cmd "…"] [--include-dist] [--push-existing] [--private] [--yes]
                                                GitHub+Render 永久部署
  dsh-deploy status                              查看运行中的部署
  dsh-deploy stop [all|server|tunnel]            停止部署

安全说明:
  · 永久模式默认创建【公开】仓库，TTY 下会二次确认；非交互需 --yes
  · --include-dist  显式把被 .gitignore 排除的 dist/ 纳入发布
  · --push-existing 允许推送到项目已有的 origin（默认拒绝，防误推）
  · 敏感文件（.env*/私钥/凭据等）会被自动拦截并报告

示例:
  dsh-deploy tunnel "D:\\my-project"
  dsh-deploy permanent "D:\\my-project" --repo my-project --include-dist
  dsh-deploy doctor "D:\\my-project"`)
}

async function main(): Promise<void> {
  switch (cmd) {
    case 'tunnel': await cmdTunnel(args.slice(1)); break
    case 'permanent': await cmdPermanent(args.slice(1)); break
    case 'status': cmdStatus(); break
    case 'stop': cmdStop(args.slice(1)); break
    case 'doctor': await cmdDoctor(args.slice(1)); break
    default: help(); break
  }
}

main().catch((e) => { console.error('✗ ' + (e as Error).message); process.exit(1) })
