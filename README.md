# GoNavi SSH（gh-autumnnazi.ssh）

[GoNavi](https://github.com/Syngnat/GoNavi) 的 SSH 运维插件：加密连接档案、交互式 PTY 终端、
SFTP 双栏文件管理、后台任务与 Agent 工具。主机密钥 TOFU；支持 ProxyJump（≤3 跳）、
键盘交互双因素（TOTP 弹窗）、只读模式与 sudo 白名单。

## 架构

```
GoNavi 宿主 ──JSON-RPC(stdin/stdout)──► 插件后端进程(Go) ──SSH──► 服务器（可经跳板链）
     │                                      ├─ profile   档案 + AES-GCM 加密存储（含跳板凭据）
     └─ window.entry 独立窗口               ├─ sshclient 两段式连接：needInput 交互认证 / keepalive / TOFU
        (React+AntD+xterm.js)               ├─ terminal  PTY 多会话 / 长轮询读 / 广播输入 / 行历史
                                            ├─ sftpops   远程+本地 FS / 递归删 / statvfs / 预览
                                            ├─ transfer  直传磁盘：进度/取消/断点/原子替换
                                            ├─ agentcmd  exec / execSudo / runBg / metrics / triage
                                            └─ settings  只读开关 / sudo 白名单 / 快速命令
```

核心约束与对策（GoNavi 插件协议 v1）：

| 约束 | 对策 |
|---|---|
| 插件无法向宿主推送事件 | 终端输出长轮询；连接/传输状态轮询 |
| 独立窗口桥 8 并发 / 30s / 1MiB | 长轮询 ≤20s 等待；终端 I/O base64 分块；agent 长命令走 runBg |
| 认证可能需要动态码（TOTP） | 两段式连接：conn.open 即返 → conn.status 轮询 → needInput 弹窗 → conn.answer 续跑 |
| WebView 无网络访问 | 前端资产全部打包进插件包 |
| 帧上限 1 MiB | 文件内容不过桥：SFTP 传输由插件进程直传本地磁盘 |

## 目录

```
cmd/plugin/         入口：stdin/stdout JSON-RPC 服务
internal/profile/   连接档案（含跳板链）；密码/口令 AES-GCM 加密落盘 ~/.gonavi-ssh/
internal/sshclient/ 两段式连接管理、交互认证、ProxyJump、TOFU known_hosts、keepalive
internal/terminal/  PTY 会话、输出缓冲、长轮询读、广播写、行历史抽取
internal/sftpops/   SFTP 与本地 FS 操作（列表/增删改/预览/磁盘用量）
internal/transfer/  传输任务（上传原子替换 / 下载 .part 断点续传 / 进度 / 取消）
internal/agentcmd/  agent.exec / execSudo / runBg / taskStatus / metrics / triage
internal/settings/  只读模式（含 GONAVI_SSH_READ_ONLY=1 强制）、sudo 白名单、快速命令
internal/server/    49 个命令的路由与只读 gate
frontend/           独立窗口 UI（React 18 + AntD 5 + xterm.js，六语言跟随宿主）
scripts/package.sh  组装插件包（三平台二进制 + 前端 + 清单 → zip）
```

## 开发

依赖：Go 1.26.0+、Node 18+；`go.mod` 中 SDK 通过 replace 指向本机 GoNavi 仓库
（`E:/code/GoNavi/sdk/go`，按需修改）。

```sh
go test ./...                        # 后端测试
(cd frontend && npm install && npm run build)  # 首次准备依赖 / 单独构建
node --test scripts/package.test.mjs           # 打包行为回归（临时目录）
bash scripts/package.sh                       # 组包 → dist/*.zip
```

组包默认读取 `gonavi.plugin.json` 的 `id` 与 `version`，v0.1.1 输出为 `dist/gh-autumnnazi.ssh-0.1.1.zip`；显式传入版本（如 `bash scripts/package.sh 0.1.1`）必须与清单一致，否则在构建与修改产物前停止。组包直接用现有 Node 执行本地 TypeScript 类型检查与 Vite 构建，失败即停止，不调用 npm 包装器，也不安装依赖。ZIP 仅包含 `bin/`、`frontend/` 和 `gonavi.plugin.json`，条目不带 `./`；重打时清除旧归档，避免残留资源。最终验收应对该 ZIP 运行宿主 `inspect`，不能只检查 `package/` 目录。

设置 `GONAVI_HOST_ROOT` 为 GoNavi 源码目录后，上述测试会通过临时 Go overlay 调用真实 `InspectPackage`，验证旧 `./` 归档被拒绝、新归档与目录 digest 一致；不修改宿主源码，也不安装插件。可用 `GO_BIN`、`BASH_BIN` 指定已有工具的路径。

插件运行在宿主内时，数据目录使用宿主分配的私有目录（`GONAVI_PLUGIN_DATA`）；
独立运行时回落到 `~/.gonavi-ssh`，可用 `GONAVI_SSH_HOME` 覆盖；`GONAVI_SSH_READ_ONLY=1` 强制只读。

## 安装（开发验证）

```sh
gonavi plugin --root ./devroot check package/
gonavi plugin --root ./devroot inspect dist/gh-autumnnazi.ssh-0.1.1.zip  # 拿最终 ZIP 的 digest
gonavi plugin --root ./devroot install --digest <digest> --trust dist/gh-autumnnazi.ssh-0.1.1.zip
gonavi plugin --root ./devroot enable gh-autumnnazi.ssh
```

或在 GoNavi 桌面端「设置中心 → 插件 → 本地安装」选择 `dist/gh-autumnnazi.ssh-0.1.1.zip`（开发验证也可选择 `package/` 目录）。

## v0.1.1 命名修正重发（发布前说明）

本次拟重发 v0.1.1：插件 ID 为 `gh-autumnnazi.ssh`，安装包为 `gh-autumnnazi.ssh-0.1.1.zip`，使用 `<插件 ID>-<版本>.zip`，与 Log2SQL 命名格式一致。旧 v0.1.1 曾使用 `autumnnazi.ssh`；待新包验收通过后，将删除其旧 Release、资产及标签，创建指向新提交的 v0.1.1 标签并以新包重新发布。v0.1.0 的 Release、资产和标签保持不变，不覆盖。

宿主将新 ID 视为独立插件，不是旧插件的原位升级，宿主分配的数据目录也不同；现有连接档案和配置不会自动迁移。安装新 ID 前请保留旧实例及其数据，不要直接删除；本次不修改已安装插件，也不自动迁移数据。

## v0.1.1 发布说明

- 本版补齐清单中的 `minHostVersion: "1.2.0"`，本次安装包最低要求 **GoNavi 1.2.0**（与 Log2SQL v0.1.3 一致）。已发布的 v0.1.0 安装包未声明此字段；其 Release 和资产保持不变，不覆盖旧发布。
- 安装包继续包含 Windows/amd64、Linux/amd64、macOS/arm64 后端与离线前端资源，包名与清单版本同步为 0.1.1。
- 宿主兼容：实时主题同步还需使用包含 `PluginUpdateWindowPreferences` 接口及窗口偏好通道的宿主构建；版本号达到门槛并不代表已包含这些改动。低于最低版本的正式发布宿主会阻止插件运行；开发测试构建按宿主版本规则例外。更新 SSH 插件不会升级 GoNavi 主程序，宿主需由用户另行升级。

## Agent 工具（ai.tools）

清单声明了 `ai.tools`：全部 49 个命令进入 GoNavi Agent 工具目录（`plugin__` 前缀），
GoNavi 自带 MCP Server 时可被外部编码代理调用。写效果命令统一标 `side_effect_unknown`
走宿主审批；插件级只读模式开启后所有写命令直接拒绝。

## 安全说明

- 密码、私钥口令、跳板凭据使用本机数据目录内主密钥 AES-GCM 加密存储；密钥文件 0600。
- 主机密钥 TOFU（含每一跳）：首次记录，变更拒绝并报新旧指纹；跳板后主机按逻辑地址记录。
- sudo 只允许白名单前缀且非交互（`sudo -n`）；命令执行输出限量 512 KiB。
- 命令响应、日志不含凭据明文；认证错误统一脱敏。
- OSC7 目录跟随需要远端 shell 主动上报（PROMPT_COMMAND），插件只读取不注入。

## 功能清单

**终端**
- PTY 多会话、同连接复用、窗口尺寸跟随
- 广播输入（同连接多会话同步）、快速命令按钮、Ctrl+C、剪贴板粘贴、亡会话回看；命令历史使用远端 shell 自带的 `history` 或方向键，不提供插件历史按钮
- 交互认证（TOTP 等）弹窗应答；ProxyJump ≤3 跳；keepalive 探活
- 目录跟随（可选）：新终端自动注入 OSC7 钩子，文件面板跟随 `cd`（bash/zsh）

**认证与凭据**
- 密码 / 私钥（含口令）/ SSH Agent / 无认证
- Quick Sudo：档案级 sudo 密码（加密存储）自动注入，支持一次性动态码参数
- 主机密钥 TOFU（含每一跳）：变更拒绝并报新旧指纹；known_hosts 可在设置中查看/删除

**SFTP**
- 双栏浏览（面包屑导航 + 前进/后退 + 路径编辑 + 磁盘用量）
- 上传/下载：原生文件/目录选择器、进度/速率、取消、断点续传、原子替换
- 远端复制（服务器端流式）、重命名、新建、chmod、递归删除、小文件预览编辑

**Agent 工具**
- `agent.exec` / `execSudo`（白名单）/ `execMulti`（≤10 主机并行汇总）/ `runBg` + `taskStatus` + `taskCancel` / `metrics` / `triage`
- 只读模式（含只读巡检白名单）、危险命令确认门（force 二次确认）、本地路径边界

**宿主集成**
- 语言与亮/暗主题跟随 GoNavi 主程序（zh-CN / zh-TW / en-US / ja-JP / de-DE / ru-RU）
- 从 GoNavi 数据库连接导入 SSH 隧道主机（非敏感字段，幂等）
- 关闭插件窗口自动断开本窗口建立的全部连接（宿主回调 + 启动兜底）

