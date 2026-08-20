/**
 * @dsh-external/dsh-deploy-public —— DSH 插件入口（薄封装）。
 * 核心逻辑在 ./engine.js（纯 Node，CLI 与插件共用）。
 *
 * 工具：
 *   deploy_public  一键把本地项目部署到公网（tunnel 临时链接 / permanent GitHub+Render）
 *   deploy_status  查看运行中的 server/tunnel/授权进程
 *   deploy_stop    停止进程
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  readStartScript, defaultPortOf, waitHealthy, waitTunnelUrl, verifyPublic,
  startDeviceFlow, finishGhAuth, ghAuthed, publishToGithub, GH_TOKEN_FILE, killPidTree,
} from './engine.js'

export const name = '@dsh-external/dsh-deploy-public'
export const inject = ['tools']

export interface Config {
  cloudflaredBin: string
  defaultPort: number
}

export const Config = z.object({
  cloudflaredBin: z.string().default('cloudflared'),
  defaultPort: z.number().default(4173),
})

// ---------------------------------------------------------------------------
// 进程注册表：工具调用返回后，服务器/隧道进程继续存活，可被 status/stop 管理
// ---------------------------------------------------------------------------
interface Running {
  id: string
  kind: 'server' | 'tunnel'
  port?: number
  url?: string
  child: ChildProcess
  logs: string[]
  startedAt: number
}
const registry = new Map<string, Running>()
let seq = 0

function tailLogs(logs: string[], n = 40): string {
  return logs.slice(-n).join('\n')
}

function remember(kind: Running['kind'], child: ChildProcess, extra: { port?: number } = {}): Running {
  const id = `${kind}-${++seq}`
  const r: Running = { id, kind, child, logs: [], startedAt: Date.now(), ...extra }
  registry.set(id, r)
  child.stdout?.on('data', (d) => { r.logs.push(String(d)); if (r.logs.length > 500) r.logs.splice(0, 100) })
  child.stderr?.on('data', (d) => { r.logs.push(String(d)); if (r.logs.length > 500) r.logs.splice(0, 100) })
  child.on('close', () => { /* keep entry for status inspection */ })
  return r
}

function killAllChildren(): void {
  for (const r of registry.values()) {
    try { killPidTree(r.child.pid ?? -1) } catch { try { r.child.kill() } catch { /* noop */ } }
  }
  registry.clear()
}

export function apply(ctx: Context, config: Config): void {
  // 插件卸载/重载时清理所有子进程
  ctx.effect(() => { killAllChildren(); return killAllChildren })

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'deploy_public',
    description: '一键把本地项目部署到公网。mode=tunnel：自动启动服务→健康检查→cloudflared 隧道→返回公网 URL（零账号，链接临时）；mode=permanent：GitHub 设备流授权→建仓/提交/推送→生成 render.yaml 并给出 Render 永久部署步骤。网络不稳时自动重试。',
    parameters: {
      project_dir: { type: 'string', required: true, description: '项目绝对路径' },
      mode: { type: 'string', enum: ['tunnel', 'permanent'], description: 'tunnel=临时公网链接（默认）；permanent=GitHub+Render 永久部署' },
      port: { type: 'integer', description: '本地服务端口（缺省自动探测，默认 4173）' },
      start_command: { type: 'string', description: '启动命令，如 "node dist/src/apps/api/server.js"（缺省取 package.json 的 start 脚本）' },
      repo_name: { type: 'string', description: 'GitHub 仓库名（permanent 模式；缺省用项目目录名）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: Record<string, unknown>) {
      const projectDir = String(args.project_dir)
      if (!existsSync(projectDir)) {
        return JSON.stringify({ status: 'error', detail: `project_dir 不存在: ${projectDir}` })
      }
      const mode = String(args.mode ?? 'tunnel')
      const scripts = readStartScript(projectDir)
      const startCommand = String(args.start_command ?? scripts.start ?? scripts.dev ?? '')

      if (mode === 'tunnel') {
        const port = Number(args.port ?? defaultPortOf(projectDir, config.defaultPort))
        // 1) 启动服务（复用同端口已有进程）
        let server: Running | undefined
        const existing = [...registry.values()].find((r) => r.kind === 'server' && r.port === port)
        if (existing && existing.child.exitCode === null) {
          server = existing
        } else if (startCommand) {
          const child = spawn(startCommand, { cwd: projectDir, env: { ...process.env, PORT: String(port) }, shell: true, windowsHide: true })
          server = remember('server', child, { port })
          child.on('error', () => { /* surfaced via logs */ })
        } else {
          return JSON.stringify({ status: 'error', detail: '未找到启动命令：请传 start_command 或在 package.json 配 start/dev 脚本' })
        }
        // 2) 健康检查
        const health = await waitHealthy(port)
        if (!health.ok) {
          return JSON.stringify({ status: 'error', step: 'health', detail: health.detail, logs: tailLogs(server.logs, 15) })
        }
        // 3) 隧道
        const tunnelChild = spawn(config.cloudflaredBin, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], { windowsHide: true })
        const tunnel = remember('tunnel', tunnelChild, { port })
        const url = await waitTunnelUrl(() => tunnel.logs.join('\n'))
        if (!url) {
          return JSON.stringify({ status: 'error', step: 'tunnel', detail: 'cloudflared 未输出 URL', logs: tailLogs(tunnel.logs, 15) })
        }
        tunnel.url = url
        // 4) 公网验证
        const v = await verifyPublic(url + '/api/health')
        const note = v.ok
          ? '链接依赖本机保持运行，机器关机/隧道停止即失效；演示完可用 deploy_stop 关闭。'
          : `隧道已建立但本地 DNS 无法解析 trycloudflare 子域名（${v.detail}）。解决办法：① 网络设置把 DNS 改为公共 DNS（如 8.8.8.8 / 223.5.5.5）；② 浏览器开启安全 DNS（Chrome/Edge 设置→隐私→安全 DNS）；③ 用手机流量访问。链接依赖本机保持运行。`
        return JSON.stringify({
          status: v.ok ? 'live' : v.directOk ? 'live_dns_issue' : 'degraded',
          mode: 'tunnel',
          url,
          port,
          server_id: server.id,
          tunnel_id: tunnel.id,
          verify: v.detail,
          note,
        })
      }

      if (mode === 'permanent') {
        // 1) 若上一轮授权已完成（token 已落地），先收尾
        const fin = await finishGhAuth()
        if (!fin.ok && existsSync(GH_TOKEN_FILE)) {
          return JSON.stringify({ status: 'error', step: 'finish-auth', detail: fin.detail })
        }
        // 2) 仍未认证 → 发起新授权（非阻塞，返回设备码让用户授权）
        if (!(await ghAuthed())) {
          const flow = startDeviceFlow()
          if ('error' in flow) {
            return JSON.stringify({ status: 'error', step: 'device-flow', detail: flow.error })
          }
          return JSON.stringify({
            status: 'awaiting_auth',
            user_code: flow.userCode,
            verify_url: flow.verifyUrl,
            next: '请用户打开 ' + flow.verifyUrl + ' 输入设备码 ' + flow.userCode + ' 并 Authorize；授权后再次调用 deploy_public 同一参数即可继续。',
          })
        }
        // 3) 发布
        const repoName = String(args.repo_name ?? projectDir.split(/[\\/]/).pop() ?? 'deploy').replace(/[^a-zA-Z0-9._-]/g, '-')
        const result = await publishToGithub(projectDir, repoName, startCommand || undefined)
        return JSON.stringify(result)
      }

      return JSON.stringify({ status: 'error', detail: `未知 mode: ${mode}` })
    },
  })), '@dsh-external/dsh-deploy-public: deploy_public')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'deploy_status',
    description: '查看 deploy_public 启动的服务器/隧道进程的运行状态与日志尾部。',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      const lines = [...registry.values()].map((r) => {
        const alive = r.child.exitCode === null ? 'running' : `exited(${r.child.exitCode})`
        return `${r.id} ${r.kind} ${alive} port=${r.port ?? '-'} url=${r.url ?? '-'} started=${new Date(r.startedAt).toLocaleTimeString()}\n  logs: ${tailLogs(r.logs, 6).replace(/\n/g, '\n  ')}`
      })
      return lines.length ? lines.join('\n') : 'no active deploys'
    },
  })), '@dsh-external/dsh-deploy-public: deploy_status')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'deploy_stop',
    description: '停止 deploy_public 启动的进程：传 id 停止单个（如 server-3 / tunnel-4），传 all 停止全部。',
    parameters: {
      id: { type: 'string', required: true, description: '进程 id（deploy_status 可查）或 all' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: Record<string, unknown>) {
      const id = String(args.id)
      const targets = id === 'all' ? [...registry.keys()] : [id]
      const stopped: string[] = []
      for (const t of targets) {
        const r = registry.get(t)
        if (!r) continue
        try { killPidTree(r.child.pid ?? -1) } catch { try { r.child.kill() } catch { /* noop */ } }
        stopped.push(t)
      }
      return JSON.stringify({ stopped, remaining: [...registry.keys()].filter((k) => !stopped.includes(k)) })
    },
  })), '@dsh-external/dsh-deploy-public: deploy_stop')
}
