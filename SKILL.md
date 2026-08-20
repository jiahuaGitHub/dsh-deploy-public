---
name: deploy-to-public
description: "部署上网/部署到公网/发到网上/上线/公网链接/临时公网地址/让朋友访问/外网访问/trycloudflare/render 部署/一条指令部署 —— 用户要求把本地项目部署到公网时，用 dsh-deploy-public 的能力（DSH 插件工具 deploy_public，或独立 CLI `dsh-deploy`）一键完成：自动启动服务→健康检查→cloudflared 隧道（零账号临时链接）或 GitHub+Render 永久部署（首次需用户浏览器授权一次）。不要自己手搓 cloudflared/git 命令；tunnel 模式无需任何账号，permanent 模式返回设备码时把授权步骤清晰转达给用户并等其授权后再继续。"
---

# Deploy a local project to the public internet

When the user says "帮我把 X 部署上网 / 部署到公网 / 上线 / 给我一个公网链接" (any wording), use the dsh-deploy-public engine instead of doing the steps by hand.

## Two entry points (same engine)

1. **DSH 插件工具（本会话内）**：直接调 `deploy_public { project_dir, mode }`。`mode: "tunnel"`（默认）零账号、约 1 分钟出公网 URL；`mode: "permanent"` 走 GitHub+Render，未授权时返回 `awaiting_auth`（含 `user_code` + `verify_url`）——转达给用户，让用户浏览器打开并授权（永远不要向用户索要 token/密码），授权后再次调用同一参数即可继续。
2. **独立 CLI（任何终端，无需 DSH）**：`npx dsh-deploy tunnel <dir>` / `dsh-deploy permanent <dir>` / `dsh-deploy doctor` / `dsh-deploy status` / `dsh-deploy stop all`。对"别人"交付时优先推荐 CLI（安装：`npm i -g dsh-deploy-public` 或从 GitHub Release 装 tgz）。

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
