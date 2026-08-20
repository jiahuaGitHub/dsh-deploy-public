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
/** 短命令（node/git/gh），args 数组，无 shell —— 路径带空格也安全 */
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
/** 从可轮询的日志读取器里等 trycloudflare URL */
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
export declare const GH_TOKEN_FILE: string;
export interface DeviceFlowHandle {
    userCode: string;
    verifyUrl: string;
    promise: Promise<'ok' | 'expired' | 'error'>;
}
/** 发起设备流并返回句柄；轮询在进程内后台进行（插件/CLI 共用）。token 写 TOKEN_FILE。 */
export declare function startDeviceFlow(): DeviceFlowHandle | {
    error: string;
};
export declare function ghAuthed(): Promise<boolean>;
/** 从临时文件取 token → 喂给 gh（stdin，不打印）→ 成功才删除文件 */
export declare function finishGhAuth(): Promise<{
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
export declare function publishToGithub(projectDir: string, repoName: string, startCommand: string | undefined): Promise<Record<string, unknown>>;
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
