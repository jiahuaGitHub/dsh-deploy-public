#!/usr/bin/env node
/**
 * dsh-deploy-public CLI —— 一条命令把本地项目部署到公网，无需 DeepSeek Harness。
 *
 *   dsh-deploy doctor [dir]                       环境自检
 *   dsh-deploy tunnel <dir> [--port N] [--start-cmd "…"]   临时公网链接（零账号）
 *   dsh-deploy permanent <dir> [--repo NAME] [--start-cmd "…"]  GitHub+Render 永久部署
 *   dsh-deploy status                             查看运行中的部署
 *   dsh-deploy stop [all|server|tunnel]           停止部署
 *
 * 安装：npm i -g dsh-deploy-public  或  npx dsh-deploy-public …
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readStartScript, defaultPortOf, waitHealthy, waitTunnelUrl, verifyPublic, ensureGhAuthBlocking, publishToGithub, doctor, STATE_DIR, STATE_FILE, loadState, saveState, clearState, pidAlive, killPidTree, spawnDetached, tailFile, } from './engine.js';
const args = process.argv.slice(2);
const cmd = args[0] ?? 'help';
function flagValue(rest, name) {
    const i = rest.findIndex((a) => a === name);
    if (i >= 0 && rest[i + 1])
        return rest[i + 1];
    const eq = rest.find((a) => a.startsWith(name + '='));
    return eq ? eq.slice(name.length + 1) : undefined;
}
function parseCommon(rest) {
    const dir = rest.find((a) => !a.startsWith('-')) ?? '';
    if (!dir || !existsSync(dir)) {
        console.error('✗ 需要项目目录（绝对路径）：dsh-deploy tunnel D:\\path\\to\\project');
        process.exit(1);
    }
    const port = flagValue(rest, '--port');
    return { dir, port: port ? Number(port) : undefined, startCmd: flagValue(rest, '--start-cmd') };
}
async function cmdTunnel(rest) {
    const { dir, port, startCmd } = parseCommon(rest);
    const state = loadState();
    if (state && pidAlive(state.server.pid) && state.projectDir === dir) {
        console.log(`已存在部署：${state.tunnel?.url ?? '隧道建立中'}（dsh-deploy stop all 可先停掉）`);
        return;
    }
    const portN = port ?? defaultPortOf(dir, 4173);
    const scripts = readStartScript(dir);
    const cmdLine = startCmd ?? scripts.start ?? scripts.dev;
    if (!cmdLine) {
        console.error('✗ 未找到启动命令：请在 package.json 配 start/dev 脚本，或用 --start-cmd 指定');
        process.exit(1);
    }
    const logDir = path.join(STATE_DIR, 'logs');
    const serverLog = path.join(logDir, 'server.log');
    const serverChild = spawnDetached(cmdLine, dir, serverLog, { PORT: String(portN) });
    const serverPid = serverChild.pid;
    if (!serverPid) {
        console.error('✗ 服务启动失败');
        process.exit(1);
    }
    saveState({ projectDir: dir, port: portN, server: { pid: serverPid, startedAt: Date.now() } });
    console.log(`[1/4] 服务已启动 pid=${serverPid} 日志=${serverLog}`);
    console.log('[2/4] 本地健康检查中…');
    const health = await waitHealthy(portN);
    if (!health.ok) {
        console.error('✗ 健康检查失败: ' + health.detail + '\n服务日志尾部:\n' + tailFile(serverLog, 15));
        process.exit(1);
    }
    console.log(`    通过 ${health.detail}`);
    console.log('[3/4] 建立 cloudflared 隧道…');
    const tunnelLog = path.join(logDir, 'tunnel.log');
    const tunnelChild = spawnDetached(`cloudflared tunnel --url http://127.0.0.1:${portN} --no-autoupdate`, dir, tunnelLog);
    const tunnelPid = tunnelChild.pid;
    const url = await waitTunnelUrl(() => tailFile(tunnelLog, 200));
    if (!url) {
        console.error('✗ 未获取到隧道 URL\n隧道日志尾部:\n' + tailFile(tunnelLog, 20));
        process.exit(1);
    }
    const st = loadState() ?? { projectDir: dir, port: portN, server: { pid: serverPid, startedAt: Date.now() } };
    st.tunnel = { pid: tunnelPid, url };
    saveState(st);
    console.log(`    ${url}`);
    console.log('[4/4] 公网验证中…');
    const v = await verifyPublic(url + '/api/health');
    console.log(`    ${v.detail}`);
    if (v.ok || v.directOk) {
        console.log('\n✅ 公网地址: ' + url);
    }
    else {
        console.log('\n⚠️ 隧道已建立但本机 DNS 无法解析 trycloudflare 子域名。');
        console.log('   解决：① DNS 改公共（8.8.8.8/223.5.5.5）② 浏览器开「安全 DNS」③ 手机流量访问');
        console.log('   地址: ' + url);
    }
    console.log('\n管理：dsh-deploy status | dsh-deploy stop all');
}
async function cmdPermanent(rest) {
    const { dir, startCmd } = parseCommon(rest);
    const repo = flagValue(rest, '--repo') ?? path.basename(dir).replace(/[^a-zA-Z0-9._-]/g, '-');
    const scripts = readStartScript(dir);
    const cmdLine = startCmd ?? scripts.start ?? '';
    console.log('[1/3] GitHub 授权检查…');
    const auth = await ensureGhAuthBlocking();
    if (!auth.ok) {
        console.error('✗ GitHub 授权失败: ' + auth.detail);
        process.exit(1);
    }
    console.log('    ✓ ' + auth.detail);
    console.log(`[2/3] 建仓/提交/推送（仓库 ${repo}，网络不稳自动重试）…`);
    const result = await publishToGithub(dir, repo, cmdLine || undefined);
    console.log('[3/3] 完成');
    console.log(JSON.stringify(result, null, 2));
}
function cmdStatus() {
    const st = loadState();
    if (!st) {
        console.log('无部署记录（state 文件: ' + STATE_FILE + '）');
        return;
    }
    const serverAlive = pidAlive(st.server.pid);
    const tunnelAlive = st.tunnel ? pidAlive(st.tunnel.pid) : false;
    console.log(JSON.stringify({
        projectDir: st.projectDir,
        port: st.port,
        server: { pid: st.server.pid, alive: serverAlive },
        tunnel: st.tunnel ? { pid: st.tunnel.pid, alive: tunnelAlive, url: st.tunnel.url } : null,
        serverLog: tailFile(path.join(STATE_DIR, 'logs', 'server.log'), 5),
        tunnelLog: tailFile(path.join(STATE_DIR, 'logs', 'tunnel.log'), 5),
    }, null, 2));
}
function cmdStop(rest) {
    const st = loadState();
    if (!st) {
        console.log('无部署记录');
        return;
    }
    const target = rest[0] ?? 'all';
    const killed = [];
    if ((target === 'all' || target === 'tunnel') && st.tunnel) {
        killed.push('tunnel ' + killPidTree(st.tunnel.pid));
    }
    if ((target === 'all' || target === 'server')) {
        killed.push('server ' + killPidTree(st.server.pid));
    }
    clearState();
    console.log('已停止: ' + killed.join('; ') || '无');
}
async function cmdDoctor(rest) {
    const dir = rest.find((a) => !a.startsWith('-'));
    const r = await doctor(dir);
    for (const c of r.checks) {
        console.log(`${c.pass ? '✓' : '✗'} ${c.name.padEnd(12)} ${c.detail}`);
    }
    console.log(r.ok ? '\n✅ 环境就绪，可以部署' : '\n⚠️ 有未通过项，按上面提示安装/配置后重试');
}
function help() {
    console.log(`dsh-deploy-public — 一条命令把本地项目部署到公网

用法:
  dsh-deploy doctor [dir]                        环境自检
  dsh-deploy tunnel <dir> [--port N] [--start-cmd "…"]   临时公网链接（零账号）
  dsh-deploy permanent <dir> [--repo NAME] [--start-cmd "…"]  GitHub+Render 永久部署
  dsh-deploy status                              查看运行中的部署
  dsh-deploy stop [all|server|tunnel]            停止部署

示例:
  dsh-deploy tunnel "D:\\my-project"
  dsh-deploy permanent "D:\\my-project" --repo my-project
  dsh-deploy doctor "D:\\my-project"`);
}
async function main() {
    switch (cmd) {
        case 'tunnel':
            await cmdTunnel(args.slice(1));
            break;
        case 'permanent':
            await cmdPermanent(args.slice(1));
            break;
        case 'status':
            cmdStatus();
            break;
        case 'stop':
            cmdStop(args.slice(1));
            break;
        case 'doctor':
            await cmdDoctor(args.slice(1));
            break;
        default:
            help();
            break;
    }
}
main().catch((e) => { console.error('✗ ' + e.message); process.exit(1); });
//# sourceMappingURL=cli.js.map