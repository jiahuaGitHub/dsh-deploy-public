/**
 * dsh-deploy-public engine — 纯 Node 部署引擎（零 cordis 依赖）。
 * 被两处共用：DSH 插件（src/index.ts）与独立 CLI（src/cli.ts）。
 *
 * 已固化的本机网络经验：
 *  - gh CLI 的 Go 网络栈连不上 github.com → 设备流用 Node fetch 实现（含 read:org scope）
 *  - git push 不稳 → 内置重试
 *  - 路径含空格 → args 数组 + shell:false（仅用户自带的 start_command 用 shell）
 *  - 本地 DNS 污染 trycloudflare 子域名 → 8.8.8.8 独立 Resolver + 边缘 IP 直连兜底验证
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import dns from 'node:dns'
import https from 'node:https'
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, appendFileSync, openSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------
export function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

/** 短命令（node/git/gh），args 数组，无 shell —— 路径带空格也安全 */
export function runArgs(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; input?: string } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env }, windowsHide: true })
    let out = '', err = ''
    child.stdout?.on('data', (d) => { out += d })
    child.stderr?.on('data', (d) => { err += d })
    if (opts.input !== undefined) {
      child.stdin.on('error', () => {})
      child.stdin.write(opts.input)
      child.stdin.end()
    }
    const t = opts.timeoutMs ? setTimeout(() => { try { child.kill() } catch { /* noop */ } }, opts.timeoutMs) : undefined
    child.on('close', (code) => { if (t) clearTimeout(t); resolve({ code, stdout: out, stderr: err }) })
    child.on('error', (e) => { if (t) clearTimeout(t); resolve({ code: -1, stdout: out, stderr: String(e) }) })
  })
}

export function readStartScript(projectDir: string): { start?: string; dev?: string } {
  const p = path.join(projectDir, 'package.json')
  if (!existsSync(p)) return {}
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'))
    return { start: j?.scripts?.start, dev: j?.scripts?.dev }
  } catch { return {} }
}

export function defaultPortOf(projectDir: string, fallback: number): number {
  const s = readStartScript(projectDir)
  const hay = `${s.start ?? ''} ${s.dev ?? ''}`
  const m = hay.match(/(?:PORT|port)(?:=|\s+)?(\d{3,5})/)
  if (m) return Number(m[1])
  if (hay.includes('vite')) return 5173
  if (hay.includes('next')) return 3000
  return fallback
}

// ---------------------------------------------------------------------------
// 本地健康检查 / 隧道 URL 等待 / 公网验证
// ---------------------------------------------------------------------------
export async function waitHealthy(port: number, timeoutMs = 40_000): Promise<{ ok: boolean; detail: string }> {
  const base = `http://127.0.0.1:${port}`
  const paths = ['/api/health', '/']
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const p of paths) {
      try {
        const r = await fetch(base + p, { signal: AbortSignal.timeout(4000) })
        if (r.status < 500) return { ok: true, detail: `${p} -> ${r.status}` }
      } catch { /* keep polling */ }
    }
    await sleep(1500)
  }
  return { ok: false, detail: 'no route answered within timeout' }
}

/** 从可轮询的日志读取器里等 trycloudflare URL */
export async function waitTunnelUrl(getLogs: () => string, timeoutMs = 45_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const m = getLogs().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
    if (m) return m[0]
    await sleep(1000)
  }
  return null
}

/** 用 8.8.8.8 解析 + IP 直连（SNI/Host 带原域名），绕过本地 DNS 污染验证隧道本身 */
export function directHttpsProbe(hostname: string, ip: string, pathname: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = https.get({
      host: ip,
      servername: hostname,
      path: pathname || '/',
      headers: { host: hostname },
      rejectUnauthorized: true,
      timeout: 10_000,
    }, (res) => {
      res.resume()
      resolve(res.statusCode !== undefined && res.statusCode < 500)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

/** 公网可达性验证：fetch 重试；本地 DNS 失败时用 8.8.8.8 独立 Resolver + 边缘 IP 直连兜底 */
export async function verifyPublic(url: string): Promise<{ ok: boolean; detail: string; directOk?: boolean; ip?: string }> {
  let lastErr: Error | undefined
  for (let i = 1; i <= 5; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) })
      return { ok: r.status < 500, detail: `HTTP ${r.status}` }
    } catch (e) {
      lastErr = e as Error
      if (i < 5) await sleep(3000 * i)
    }
  }
  try {
    const u = new URL(url)
    const resolver = new dns.promises.Resolver()
    resolver.setServers(['8.8.8.8'])
    const addr = await resolver.resolve4(u.hostname)
    const ip = addr[0]
    const ok = await directHttpsProbe(u.hostname, ip, u.pathname)
    return {
      ok,
      detail: `本地 DNS 失败(${lastErr?.cause ? String((lastErr.cause as { code?: string }).code) : lastErr?.message})；8.8.8.8 直连验证 ${ok ? '正常' : '失败'}@${ip}`,
      directOk: ok,
      ip,
    }
  } catch (e2) {
    return { ok: false, detail: `fetch failed: ${lastErr?.message}; 直连兜底也失败: ${(e2 as Error).message}` }
  }
}

// ---------------------------------------------------------------------------
// GitHub 设备流（Node 实现，绕开 gh 的 Go 网络栈；token 只写临时文件，不经模型）
// ---------------------------------------------------------------------------
const TOKEN_FILE = path.join(os.tmpdir(), 'dsh-deploy-gh-token.tmp')
export const GH_TOKEN_FILE = TOKEN_FILE
const POLL_LOG = path.join(os.tmpdir(), 'dsh-deploy-gh-poll.log')

async function ghPost(url: string, params: Record<string, string>): Promise<Record<string, string>> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(20_000),
  })
  return r.json() as Promise<Record<string, string>>
}

async function ghPostRetry(url: string, params: Record<string, string>): Promise<Record<string, string>> {
  let last: unknown
  for (let i = 1; i <= 4; i++) {
    try { return await ghPost(url, params) } catch (e) { last = e; await sleep(3000 * i) }
  }
  throw last
}

export interface DeviceFlowHandle {
  userCode: string
  verifyUrl: string
  promise: Promise<'ok' | 'expired' | 'error'>
}

/** 发起设备流并返回句柄；轮询在进程内后台进行（插件/CLI 共用）。token 写 TOKEN_FILE。 */
export function startDeviceFlow(): DeviceFlowHandle | { error: string } {
  const handle: DeviceFlowHandle = { userCode: '', verifyUrl: '', promise: Promise.resolve('error') }
  const promise = (async (): Promise<'ok' | 'expired' | 'error'> => {
    try {
      const d = await ghPostRetry('https://github.com/login/device/code', {
        client_id: '178c6fc778ccc68e1d6a', // gh CLI 公开 client id
        scope: 'repo,read:org,workflow,gist',
      })
      if (!d.device_code) return 'error'
      handle.userCode = d.user_code
      handle.verifyUrl = d.verification_uri
      const deadline = Date.now() + Number(d.expires_in || 900) * 1000
      let n = 0
      while (Date.now() < deadline) {
        await sleep((Number(d.interval) || 5) * 1000)
        n++
        let t: Record<string, string>
        try {
          t = await ghPostRetry('https://github.com/login/oauth/access_token', {
            client_id: '178c6fc778ccc68e1d6a',
            device_code: d.device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          })
        } catch { appendLog('poll ' + n + ' hard-fail, continuing'); continue }
        if (t.access_token) {
          writeFileSync(TOKEN_FILE, t.access_token, 'utf8')
          appendLog('TOKEN_OBTAINED')
          return 'ok'
        }
        if (t.error === 'authorization_pending') { appendLog('poll ' + n + ': waiting for user...'); continue }
        if (t.error === 'slow_down') continue
        appendLog('poll error: ' + JSON.stringify(t))
        return 'error'
      }
      return 'expired'
    } catch (e) {
      appendLog('FATAL: ' + (e as Error).message)
      return 'error'
    }
  })()
  handle.promise = promise
  return handle
}

function appendLog(msg: string): void {
  try { appendFileSync(POLL_LOG, `${new Date().toISOString()} ${msg}\n`) } catch { /* noop */ }
}

export async function ghAuthed(): Promise<boolean> {
  const r = await runArgs('gh', ['auth', 'status'], { timeoutMs: 30_000 })
  return r.code === 0
}

/** 从临时文件取 token → 喂给 gh（stdin，不打印）→ 成功才删除文件 */
export async function finishGhAuth(): Promise<{ ok: boolean; detail: string }> {
  if (!existsSync(TOKEN_FILE)) return { ok: false, detail: 'no token yet' }
  const token = readFileSync(TOKEN_FILE, 'utf8').trim()
  if (!token) return { ok: false, detail: 'empty token' }
  const r = await runArgs('gh', ['auth', 'login', '--with-token'], { input: token, timeoutMs: 60_000 })
  if (r.code === 0) {
    try { rmSync(TOKEN_FILE) } catch { /* noop */ }
    return { ok: true, detail: 'gh authenticated' }
  }
  return { ok: false, detail: `gh rejected token: ${(r.stderr || r.stdout).trim().slice(0, 400)}` }
}

/** 确保 gh 已认证；未认证则发起设备流并阻塞等待用户授权（CLI 用） */
export async function ensureGhAuthBlocking(): Promise<{ ok: boolean; detail: string; userCode?: string; verifyUrl?: string }> {
  if (await ghAuthed()) return { ok: true, detail: 'gh already authenticated' }
  const handle = startDeviceFlow()
  if ('error' in handle) return { ok: false, detail: handle.error }
  process.stdout.write(`\n>>> 请打开 ${handle.verifyUrl} 输入设备码 ${handle.userCode} 并点击 Authorize（15 分钟内有效）...\n`)
  const status = await handle.promise
  if (status !== 'ok') return { ok: false, detail: `设备流未完成: ${status}` }
  const fin = await finishGhAuth()
  if (!fin.ok) return { ok: false, detail: fin.detail }
  return { ok: true, detail: 'gh authenticated' }
}

// ---------------------------------------------------------------------------
// permanent：建仓 + 提交 + 推送 + render.yaml
// ---------------------------------------------------------------------------
export async function publishToGithub(projectDir: string, repoName: string, startCommand: string | undefined): Promise<Record<string, unknown>> {
  const isRepo = await runArgs('git', ['-C', projectDir, 'rev-parse', '--is-inside-work-tree'], { timeoutMs: 15_000 })
  if (isRepo.code !== 0) {
    const init = await runArgs('git', ['init', '-b', 'main'], { cwd: projectDir, timeoutMs: 15_000 })
    if (init.code !== 0) return { status: 'error', step: 'git init', detail: init.stderr.trim() || init.stdout.trim() }
  }
  const hasName = await runArgs('git', ['-C', projectDir, 'config', 'user.name'], { timeoutMs: 10_000 })
  if (hasName.code !== 0) await runArgs('git', ['-C', projectDir, 'config', 'user.name', 'dsh-deploy'], { timeoutMs: 10_000 })
  const hasEmail = await runArgs('git', ['-C', projectDir, 'config', 'user.email'], { timeoutMs: 10_000 })
  if (hasEmail.code !== 0) await runArgs('git', ['-C', projectDir, 'config', 'user.email', 'dsh-deploy@users.noreply.github.com'], { timeoutMs: 10_000 })

  const distDir = path.join(projectDir, 'dist')
  if (existsSync(distDir)) {
    const ignored = await runArgs('git', ['-C', projectDir, 'check-ignore', 'dist/'], { timeoutMs: 10_000 })
    if (ignored.code === 0) await runArgs('git', ['-C', projectDir, 'add', '-f', 'dist/'], { timeoutMs: 30_000 })
  }
  await runArgs('git', ['-C', projectDir, 'add', '-A'], { timeoutMs: 30_000 })
  await runArgs('git', ['-C', projectDir, 'commit', '--allow-empty', '-m', 'deploy: auto publish to public web'], { timeoutMs: 30_000 })

  const remote = await runArgs('git', ['-C', projectDir, 'remote', 'get-url', 'origin'], { timeoutMs: 10_000 })
  if (remote.code !== 0) {
    const created = await runArgs('gh', ['repo', 'create', repoName, '--public', '--source', projectDir, '--description', 'Auto-deployed via dsh-deploy-public'], { timeoutMs: 60_000 })
    if (created.code !== 0 && !/already exists/i.test(created.stderr)) {
      return { status: 'error', step: 'gh repo create', detail: created.stderr.trim() || created.stdout.trim() }
    }
  }

  let pushDetail = ''
  for (let i = 1; i <= 5; i++) {
    const p = await runArgs('git', ['-C', projectDir, 'push', '-u', 'origin', 'HEAD'], { timeoutMs: 90_000 })
    if (p.code === 0) { pushDetail = `pushed on attempt ${i}`; break }
    pushDetail = `attempt ${i} failed: ${p.stderr.trim().split('\n').slice(-2).join(' ')}`
    await sleep(3000 * i)
  }
  if (!pushDetail.startsWith('pushed')) return { status: 'error', step: 'git push', detail: pushDetail }

  const renderFile = path.join(projectDir, 'render.yaml')
  if (!existsSync(renderFile)) {
    const cmd = startCommand ?? 'node dist/src/apps/api/server.js'
    writeFileSync(renderFile, [
      '# Render Blueprint — auto-generated by dsh-deploy-public',
      'services:',
      '  - type: web',
      '    name: ' + repoName,
      '    runtime: node',
      '    plan: free',
      '    buildCommand: ""',
      '    startCommand: ' + JSON.stringify(cmd),
      '    healthCheckPath: /api/health',
    ].join('\n') + '\n', 'utf8')
  }
  let repoUrl = `https://github.com/${repoName}`
  const view = await runArgs('gh', ['repo', 'view', repoName, '--json', 'url', '--jq', '.url'], { timeoutMs: 30_000 })
  if (view.code === 0 && view.stdout.trim()) repoUrl = view.stdout.trim()
  return {
    status: 'published',
    repo_name: repoName,
    repo_url: repoUrl,
    push: pushDetail,
    render: '在 https://render.com 登录后：New → Blueprint → 选择该仓库（render.yaml 已就位），一路 Next 即可；免费额度会因空闲休眠。',
  }
}

// ---------------------------------------------------------------------------
// CLI 专用：脱离式进程 + state 文件（跨进程管理 server/tunnel）
// ---------------------------------------------------------------------------
export const STATE_DIR = path.join(os.homedir(), '.dsh-deploy')
export const STATE_FILE = path.join(STATE_DIR, 'state.json')

export interface DeployState {
  projectDir: string
  port: number
  server: { pid: number; startedAt: number }
  tunnel?: { pid: number; url: string }
}

export function loadState(): DeployState | null {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return null }
}

export function saveState(s: DeployState): void {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8')
}

export function clearState(): void {
  try { rmSync(STATE_FILE, { force: true }) } catch { /* noop */ }
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

export function killPidTree(pid: number): string {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
      return r.status === 0 ? 'killed' : `taskkill exit ${r.status}`
    }
    process.kill(pid, 'SIGTERM')
    return 'killed'
  } catch (e) {
    return `kill failed: ${(e as Error).message}`
  }
}

/** 脱离式启动进程：CLI 拉 daemon.cjs（detached），daemon 作为普通父进程持有日志 fd 再拉真实命令。
 *  返回 daemon 子进程；真实命令的 stdout/stderr 进 logFile。 */
export function spawnDetached(cmdLine: string, cwd: string, logFile: string, env?: Record<string, string>): ChildProcess {
  mkdirSync(path.dirname(logFile), { recursive: true })
  rmSync(logFile, { force: true }) // 每次运行截断，避免旧内容误匹配（如旧隧道 URL）
  const daemon = fileURLToPath(new URL('../daemon.cjs', import.meta.url))
  const child = spawn(process.execPath, [daemon, cmdLine, logFile, JSON.stringify(env ?? {})], {
    cwd,
    env: { ...process.env },
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
  })
  child.unref() // CLI 可退出；daemon 脱离存活
  return child
}

export function tailFile(file: string, n = 30): string {
  try {
    const content = readFileSync(file, 'utf8')
    const lines = content.split('\n').filter(Boolean)
    return lines.slice(-n).join('\n')
  } catch { return '' }
}

// ---------------------------------------------------------------------------
// doctor：环境自检（别人机器上先跑这个）
// ---------------------------------------------------------------------------
export interface DoctorReport { ok: boolean; checks: Array<{ name: string; pass: boolean; detail: string }> }

export async function doctor(projectDir?: string): Promise<DoctorReport> {
  const checks: DoctorReport['checks'] = []
  const push = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail })

  push('node', process.version.startsWith('v2'), `v${process.version.slice(1)} (需要 >=20)`)

  const cf = await runArgs('cloudflared', ['--version'], { timeoutMs: 10_000 })
  push('cloudflared', cf.code === 0, cf.code === 0 ? cf.stdout.trim() || cf.stderr.trim() : '未安装 → Windows: winget install Cloudflare.cloudflared')

  const git = await runArgs('git', ['--version'], { timeoutMs: 10_000 })
  push('git', git.code === 0, git.code === 0 ? git.stdout.trim() : '未安装')

  const gh = await runArgs('gh', ['--version'], { timeoutMs: 10_000 })
  push('gh', gh.code === 0, gh.code === 0 ? gh.stdout.trim().split('\n')[0] : '未安装 → Windows: winget install GitHub.cli')

  if (gh.code === 0) {
    const auth = await runArgs('gh', ['auth', 'status'], { timeoutMs: 30_000 })
    push('gh auth', auth.code === 0, auth.code === 0 ? '已登录' : '未登录（permanent 模式会自动发起设备流授权）')
  }

  if (projectDir) {
    const pkg = readStartScript(projectDir)
    push('project', !!pkg.start || !!pkg.dev, pkg.start ? `start: ${pkg.start}` : pkg.dev ? `dev: ${pkg.dev}` : 'package.json 无 start/dev 脚本（可用 --start-cmd 指定）')
    push('dist', existsSync(path.join(projectDir, 'dist')), existsSync(path.join(projectDir, 'dist')) ? '已构建（可零构建部署）' : '无 dist/（需先构建或走 dev 服务）')
  }

  // DNS 探测：系统解析 trycloudflare 裸域
  try {
    const r = await fetch('https://trycloudflare.com', { method: 'HEAD', signal: AbortSignal.timeout(8000) })
    push('网络/DNS', true, `trycloudflare.com 可达 HTTP ${r.status}`)
  } catch (e) {
    push('网络/DNS', false, `trycloudflare.com 不可达: ${(e as Error).message}（隧道链接可能需公共 DNS/安全 DNS/手机流量）`)
  }

  return { ok: checks.every((c) => c.pass), checks }
}
