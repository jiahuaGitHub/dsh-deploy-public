# dsh-deploy-public

一句话把本地项目部署到公网。同一套引擎，两个入口：

- **独立 CLI**（任何终端，无需 DeepSeek Harness）：`npx dsh-deploy-public …` 或全局安装 `npm i -g dsh-deploy-public`
- **DSH 插件**：安装进 DeepSeek Harness 后，工具 `deploy_public` / `deploy_status` / `deploy_stop` 自动注册，配套 `deploy-to-public` 技能让 agent 在你说「部署上网」时自动调用

## 用法

```text
dsh-deploy doctor [dir]                                 环境自检（缺什么补什么）
dsh-deploy tunnel <dir> [--port N] [--start-cmd "…"]    临时公网链接（零账号，约 1 分钟）
dsh-deploy permanent <dir> [--repo NAME] [--start-cmd "…"]  GitHub+Render 永久部署
dsh-deploy status                                       查看运行中的部署
dsh-deploy stop [all|server|tunnel]                     停止部署
```

## 特性

- **tunnel 模式零账号**：自动启动服务 → 健康检查 → cloudflared 隧道 → 公网 URL
- **permanent 模式**：GitHub 设备流授权（token 只进 gh 凭据库，不落模型）→ 建仓/提交/推送（自动纳入 `dist/`）→ 生成 `render.yaml` → Render 一键 Blueprint 部署
- **网络坑全内置**：gh CLI 连不上 github.com 时用 Node 设备流绕行；git push 不稳自动重试；本地 DNS 污染 trycloudflare 子域名时用 8.8.8.8 直连兜底验证
- **进程可管理**：脱离式守护进程 + `~/.dsh-deploy/state.json`，跨进程 status/stop

## 前置条件

| 依赖 | 用途 | 安装（Windows） |
| --- | --- | --- |
| Node ≥ 18 | 运行引擎与项目 | https://nodejs.org |
| cloudflared | tunnel 模式建隧道 | `winget install Cloudflare.cloudflared` |
| git + gh | permanent 模式 | `winget install Git.Git GitHub.cli` |

先跑 `dsh-deploy doctor` 看还缺什么。

## 安装

```bash
npm i -g dsh-deploy-public          # 或
npm i -g <GitHub Release 的 tgz 地址>
```

DSH 插件安装：将本包加入 web profile 的 bundles（或 `dev_install_package`），重启后生效。

## License

BSD-3-Clause
