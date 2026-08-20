# dsh-deploy-public

一句话把本地项目部署到公网。同一套引擎，两个入口：

- **独立 CLI**（任何终端，无需 DeepSeek Harness）：`dsh-deploy tunnel <dir>` / `dsh-deploy permanent <dir>` …
- **DSH 插件**：安装进 DeepSeek Harness 后，工具 `deploy_public` / `deploy_status` / `deploy_stop` 自动注册，配套 `deploy-to-public` 技能让 agent 在你说「部署上网」时自动调用

## 安装

**DSH 用户（推荐，装完一句话触发）**

```bash
git clone https://github.com/jiahuaGitHub/dsh-deploy-public && cd dsh-deploy-public
node install.mjs          # 默认装配进 web profile：改依赖+pnpm install+SKILL 复制
# 重启 DeepSeek Harness 后 deploy_public 工具即用
# 网络不通时：node install.mjs --from-local <本目录>
```

**纯 CLI 用户（任何终端）**

```bash
# 从 GitHub Release 下载 tgz 后本地安装（本包未发布到 npm registry，勿用 npm i -g dsh-deploy-public）
curl -L -o dsh-deploy.tgz https://github.com/jiahuaGitHub/dsh-deploy-public/releases/download/v0.2.0/dsh-external-dsh-deploy-public-0.2.0.tgz
npm i -g ./dsh-deploy.tgz
```

## 用法

```text
dsh-deploy doctor [dir]                                    环境自检（只检查，不自动安装）
dsh-deploy tunnel <dir> [--port N] [--start-cmd "…"]       临时公网链接（零账号，约 1 分钟）
dsh-deploy permanent <dir> [--repo NAME] [--start-cmd "…"]
                         [--include-dist] [--push-existing] [--private] [--yes]   GitHub+Render 永久部署
dsh-deploy status                                          查看运行中的部署
dsh-deploy stop [all|server|tunnel]                        停止部署
```

## 特性

- **tunnel 模式零账号**：自动启动服务 → 健康检查（只认 2xx）→ cloudflared 隧道 → 公网 URL
- **permanent 模式**：GitHub 设备流授权（token 只进 gh 凭据库，不落模型）→ 建仓/提交/推送 → `render.yaml` → Render 一键 Blueprint 部署
- **安全默认**：公开仓库二次确认（非交互需 `--yes`）；敏感文件（`.env*`/私钥/凭据等）自动拦截；已有 `origin` 默认拒绝推送（需 `--push-existing`）；被 `.gitignore` 排除的 `dist/` 默认不纳入（需 `--include-dist`）；健康检查只认 2xx 防误暴露其他服务
- **网络坑全内置**：gh CLI 连不上 github.com 时用 Node 设备流绕行（`repo,read:org` 最小权限）；git push 不稳自动重试；本地 DNS 污染 trycloudflare 子域名时用 8.8.8.8 直连探测（明确标注为「本机探测」）
- **进程可管理**：脱离式守护进程 + `~/.dsh-deploy/state.json`，跨进程 status/stop

## 前置条件

| 依赖 | 用途 | 安装（Windows） |
| --- | --- | --- |
| Node ≥ 18 | 运行引擎与项目 | https://nodejs.org |
| cloudflared | tunnel 模式建隧道 | `winget install Cloudflare.cloudflared` |
| git + gh | permanent 模式 | `winget install Git.Git GitHub.cli` |

先跑 `dsh-deploy doctor` 看还缺什么。

## License

BSD-3-Clause
