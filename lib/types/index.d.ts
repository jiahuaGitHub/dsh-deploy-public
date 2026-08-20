/**
 * @dsh-external/dsh-deploy-public —— DSH 插件入口（薄封装）。
 * 核心逻辑在 ./engine.js（纯 Node，CLI 与插件共用）。
 *
 * 工具：
 *   deploy_public  一键把本地项目部署到公网（tunnel 临时链接 / permanent GitHub+Render）
 *   deploy_status  查看运行中的 server/tunnel/授权进程
 *   deploy_stop    停止进程
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "@dsh-external/dsh-deploy-public";
export declare const inject: string[];
export interface Config {
    cloudflaredBin: string;
    defaultPort: number;
}
export declare const Config: z<Schemastery.ObjectS<{
    cloudflaredBin: z<string, string>;
    defaultPort: z<number, number>;
}>, Schemastery.ObjectT<{
    cloudflaredBin: z<string, string>;
    defaultPort: z<number, number>;
}>>;
export declare function apply(ctx: Context, config: Config): void;
