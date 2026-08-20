// dsh-deploy daemon：脱离式进程守护。由 CLI 以 detached 方式拉起，负责把真实命令的
// stdout/stderr 转发到日志文件并保持进程树存活（Windows 上 detached 直接继承 fd 会失效，
// 所以由本守护进程作为普通父进程持有 fd）。
// 用法: node daemon.cjs "<cmdLine>" "<logFile>" ["<envJson>"]
const { spawn } = require('node:child_process')
const fs = require('node:fs')

const cmd = process.argv[2]
const logFile = process.argv[3]
let extraEnv = {}
try { extraEnv = process.argv[4] ? JSON.parse(process.argv[4]) : {} } catch { /* ignore */ }

if (!cmd || !logFile) {
  console.error('daemon: usage node daemon.cjs "<cmd>" "<logFile>" ["<envJson>"]')
  process.exit(1)
}

const fd = fs.openSync(logFile, 'a')
const child = spawn(cmd, {
  shell: true,
  env: { ...process.env, ...extraEnv },
  stdio: ['ignore', fd, fd],
  windowsHide: true,
})

child.on('close', (code) => {
  try { fs.closeSync(fd) } catch { /* noop */ }
  process.exit(code ?? 0)
})
child.on('error', () => {
  try { fs.closeSync(fd) } catch { /* noop */ }
  process.exit(1)
})
process.on('SIGTERM', () => { try { child.kill('SIGTERM') } catch { /* noop */ } })
