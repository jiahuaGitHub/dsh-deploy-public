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
import { type ChildProcess } from 'node:child_process';
export declare function sleep(ms: number): Promise<void>;
/** 短命令（node/git/gh），args 数组，无 shell —— 路径带空格也安全；输出缓冲上限 2MB */
export declare function runArgs(cmd: string, args: string[], opts?: {
    cwd?: string;
    timeoutMs?: number;
    input?: string;
}): Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
}>;
export declare function readStartScript(projectDir: string): {
    start?: string;
    dev?: string;
};
export declare function defaultPortOf(projectDir: string, fallback: number): number;
export declare function waitHealthy(port: number, timeoutMs?: number): Promise<{
    ok: boolean;
    detail: string;
}>;
/** 从可轮询的日志读取器里等 trycloudflare URL（带边界校验，防截取到 .example 之类假域名） */
export declare function waitTunnelUrl(getLogs: () => string, timeoutMs?: number): Promise<string | null>;
/** 用 8.8.8.8 解析 + IP 直连（SNI/Host 带原域名），绕过本地 DNS 污染验证隧道本身 */
export declare function directHttpsProbe(hostname: string, ip: string, pathname: string): Promise<boolean>;
/** 公网可达性验证：fetch 重试；本地 DNS 失败时用 8.8.8.8 独立 Resolver + 边缘 IP 直连兜底 */
export declare function verifyPublic(url: string): Promise<{
    ok: boolean;
    detail: string;
    directOk?: boolean;
    ip?: string;
}>;
export interface DeviceFlow {
    userCode: string;
    verifyUrl: string;
    deviceCode: string;
    interval: number;
    expiresIn: number;
    tokenFile: string;
    flowDir: string;
    promise: Promise<'ok' | 'expired' | 'error'>;
}
/** 第一步：申请设备码（await 完成才返回，码必非空）。 */
export declare function requestDeviceCode(): Promise<DeviceFlow | {
    error: string;
}>;
export declare function ghAuthed(): Promise<boolean>;
/** 从 flow 的私有 token 文件取 token → 喂给 gh（stdin，不打印）→ 成功即清理 flow 目录 */
export declare function finishGhAuth(flow: DeviceFlow): Promise<{
    ok: boolean;
    detail: string;
}>;
/** 确保 gh 已认证；未认证则发起设备流并阻塞等待用户授权（CLI 用） */
export declare function ensureGhAuthBlocking(): Promise<{
    ok: boolean;
    detail: string;
    userCode?: string;
    verifyUrl?: string;
}>;
export interface PublishOptions {
    repoName: string;
    startCommand?: string;
    includeDist?: boolean;
    allowExistingRemote?: boolean;
    visibility?: 'public' | 'private';
}
export declare function publishToGithub(projectDir: string, opts: PublishOptions): Promise<Record<string, unknown>>;
export declare const STATE_DIR: string;
export declare const STATE_FILE: string;
export interface DeployState {
    projectDir: string;
    port: number;
    server: {
        pid: number;
        startedAt: number;
    };
    tunnel?: {
        pid: number;
        url: string;
    };
}
export declare function loadState(): DeployState | null;
export declare function saveState(s: DeployState): void;
export declare function clearState(): void;
export declare function pidAlive(pid: number): boolean;
export declare function killPidTree(pid: number): string;
/** 脱离式启动进程：CLI 拉 daemon.cjs（detached），daemon 作为普通父进程持有日志 fd 再拉真实命令。
 *  返回 daemon 子进程；真实命令的 stdout/stderr 进 logFile。 */
export declare function spawnDetached(cmdLine: string, cwd: string, logFile: string, env?: Record<string, string>): ChildProcess;
export declare function tailFile(file: string, n?: number): string;
export interface DoctorReport {
    ok: boolean;
    checks: Array<{
        name: string;
        pass: boolean;
        detail: string;
    }>;
}
export declare function doctor(projectDir?: string): Promise<DoctorReport>;
