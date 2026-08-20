---
name: deploy-to-public
description: "部署上网/部署到公网/发到网上/上线/公网链接/临时公网地址/让朋友访问/外网访问/trycloudflare/render 部署/一条指令部署 —— 用户要求把本地项目部署到公网时，用 dsh-deploy-public 的能力（DSH 插件工具 deploy_public，或独立 CLI `dsh-deploy`）一键完成：自动启动服务→健康检查→cloudflared 隧道（零账号临时链接）或 GitHub+Render 永久部署（首次需用户浏览器授权一次）。不要自己手搓 cloudflared/git 命令；tunnel 模式无需任何账号，permanent 模式返回设备码时把授权步骤清晰转达给用户并等其授权后再继续。"
---

# Deploy a local project to the public internet

When the user says "帮我把 X 部署上网 / 部署到公网 / 上线 / 给我一个公网链接" (any wording), use the dsh-deploy-public engine instead of doing the steps by hand.

## Bootstrap: 引擎不存在时先安装（重要）

如果当前会话**没有** `deploy_public` / `deploy_status` / `deploy_stop` 工具，也没有 `dsh-deploy` 命令（说明这台机器还没装本能力），按以下顺序安装（仓库：`github.com/jiahuaGitHub/dsh-deploy-public`）：

1. **DSH 插件（推荐，装完可一句话触发）**：
   - `git clone https://github.com/jiahuaGitHub/dsh-deploy-public <临时目录>`（或用浏览器下载 install.mjs）
   - 运行 `node <临时目录>/install.mjs`（默认装进 web profile：写入 dependencies + bundles → `pnpm install` → 复制 SKILL 到 agent presets）
   - 重启 / 热重载 harness 后本技能自动生效，直接走下面的 deploy_public 流程
   - 网络不通时用 `node install.mjs --from-local <临时目录>`
2. **独立 CLI（任何终端）**：从 GitHub Release 下载 tgz 后 `npm i -g ./xxx.tgz`（本包未发布到 npm registry，不要用 `npm i -g dsh-deploy-public`），之后用 `dsh-deploy tunnel/permanent/doctor/status/stop`
3. 装完先跑 `dsh-deploy doctor`（CLI）确认环境（缺 cloudflared/gh 会给安装命令）。

## 安全与参数要点（转达给用户/自行遵守）

- permanent 默认创建**公开**仓库：CLI 交互式会二次确认（非交互必须 `--yes`）；插件工具默认 public，如用户要求私有传 `visibility: "private"`
- 敏感文件（`.env*`、私钥、凭据等）会被自动拦截并报告在结果里——如结果中 `staged.blocked` 非空，务必告知用户
- 项目已有 `origin` 时默认拒绝推送，需要 `allow_existing_remote: true`（CLI 为 `--push-existing`）
- 被 `.gitignore` 排除的 `dist/` 默认不发布，需要 `include_dist: true`（CLI 为 `--include-dist`）
- tunnel 模式会在结果中注明实际执行的启动命令；对不受信任的项目，先向用户展示命令再执行

## Two entry points (same engine)

1. **DSH 插件工具（本会话内）**：直接调 `deploy_public { project_dir, mode }`。`mode: "tunnel"`（默认）零账号、约 1 分钟出公网 URL；`mode: "permanent"` 走 GitHub+Render，未授权时返回 `awaiting_auth`（含 `user_code` + `verify_url`）——转达给用户，让用户浏览器打开并授权（永远不要向用户索要 token/密码），授权后再次调用同一参数即可继续。
2. **独立 CLI（任何终端，无需 DSH）**：`dsh-deploy tunnel <dir>` / `dsh-deploy permanent <dir>` / `dsh-deploy doctor` / `dsh-deploy status` / `dsh-deploy stop all`。对"别人"交付时优先推荐 CLI（安装：GitHub Release 下载 tgz 后 `npm i -g ./xxx.tgz`）。

## Workflow

1. 先跑 `doctor [dir]`（CLI）或直接部署：环境缺什么（cloudflared/gh/git）补什么；缺失时给出安装命令（Windows: `winget install Cloudflare.cloudflared` / `winget install GitHub.cli`）。
2. tunnel 模式结果里 `status: live` → 展示 URL，并说明链接依赖本机保持运行；`live_dns_issue`/`degraded` → 本机 DNS 不解析 trycloudflare 子域名，提示用户：① DNS 改公共（8.8.8.8/223.5.5.5）② 浏览器开安全 DNS ③ 手机流量访问。
3. permanent 模式发布成功后返回 `repo_url` + Render 指引（render.com → New → Blueprint → 选仓库 → Deploy）。
4. 收尾：`deploy_stop {id:'all'}`（插件）或 `dsh-deploy stop all`（CLI）。

## Rules

- 永远传项目绝对路径（可含空格，引擎已处理）。
- 项目需要先构建（`dist/` 缺失）时先构建，或传 `start_command` 走 dev 服务。
- 不手搓底层命令；重试、网络坑（gh 连不上 github.com、DNS 污染、push 不稳）都在引擎里。
- 不打印/记录 GitHub token；设备流 token 只经 stdin 进 gh 凭据库。
