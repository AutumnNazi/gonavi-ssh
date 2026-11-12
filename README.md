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
internal/server/    51 个命令的路由与只读 gate
frontend/           独立窗口 UI（React 18 + AntD 5 + xterm.js，六语言跟随宿主）
scripts/package.sh  组装插件包（三平台二进制 + 前端 + 清单 → zip）
```

## 开发

依赖：Go 1.26.0+、Node 20+。GoNavi SDK 使用仓库内固定的上游源码快照，
无需另一份宿主仓库或修改本机绝对路径；来源、许可证与升级方式见
`third_party/gonavi-sdk/UPSTREAM.md`。联调其他 SDK 可通过本地 `go.work` 覆盖。

```sh
go test ./...                        # 后端测试
go vet ./...                         # 后端静态检查
(cd frontend && npm ci && npm test && npm run build)
node scripts/ui-smoke.mjs            # 真实 React/AntD + 构建产物的浏览器回归
node --test scripts/package.test.mjs           # 打包行为回归（临时目录）
bash scripts/package.sh                       # 组包 → dist/*.zip
```

UI 回归脚本自行启动临时本地服务器并注入模拟宿主桥，不连接真实服务器。
Windows 默认使用已安装的 Edge，也可通过 `UI_BROWSER` 指定浏览器可执行文件；
其他环境先在 `frontend/` 运行 `npx playwright install chromium`。
脚本断言新版连接搜索、侧栏收起/展开、设置分组切换、文件列头，以及根节点、资源加载、浏览器异常、加载期禁止保存和连续保存两个文件，
失败返回非零退出码；截图写入 `output/playwright/`。
设置 `UI_ASSET_ROOT` 为最终 ZIP 解包后的 `frontend/` 绝对目录，可直接验收交付包里的界面。
`--inject-page-error` 用于验证失败检测，预期退出码为 1。
GitHub Actions 已串联后端 race/vet、前端测试/构建、浏览器回归和打包测试。

组包默认读取 `gonavi.plugin.json` 的 `id` 与 `version`，输出为 `dist/gh-autumnnazi.ssh-<版本>.zip`；显式传入版本（如 `bash scripts/package.sh <版本>`）必须与清单一致，否则在构建与修改产物前停止。组包直接用现有 Node 执行本地 TypeScript 类型检查与 Vite 构建，失败即停止，不调用 npm 包装器，也不安装依赖。ZIP 仅包含 `bin/`、`frontend/` 和 `gonavi.plugin.json`，条目不带 `./`；重打时清除旧归档，避免残留资源。最终验收应对该 ZIP 运行宿主 `inspect`，不能只检查 `package/` 目录。

入口文档 `frontend/index.html` 里的资源引用必须是 `/plugin-assets/frontend/` 下的绝对路径。宿主把入口文档直接放在 `/` 上返回（不再 302 到 `/plugin-assets/frontend/index.html`），文档里的相对路径会解析成 `/assets/...`，被宿主按前缀挡掉 404——窗口整个白屏，控制台也没有任何提示。因此 `frontend/vite.config.ts` 的 `base` 固定为 `'/plugin-assets/frontend/'`；组包在复制前端产物前逐个校验入口文档的 `src`/`href` 都指向该前缀下的真实文件，不满足即失败。

设置 `GONAVI_HOST_ROOT` 为 GoNavi 源码目录后，上述测试会通过临时 Go overlay 调用真实 `InspectPackage`，验证旧 `./` 归档被拒绝、新归档与目录 digest 一致；不修改宿主源码，也不安装插件。可用 `GO_BIN`、`BASH_BIN` 指定已有工具的路径。

插件运行在宿主内时，数据目录使用宿主分配的私有目录（`GONAVI_PLUGIN_DATA`）；
独立运行时回落到 `~/.gonavi-ssh`，可用 `GONAVI_SSH_HOME` 覆盖；`GONAVI_SSH_READ_ONLY=1` 强制只读。

## 安装（开发验证）

```sh
gonavi plugin --root ./devroot check package/
gonavi plugin --root ./devroot inspect dist/gh-autumnnazi.ssh-<版本>.zip  # 拿最终 ZIP 的 digest
gonavi plugin --root ./devroot install --digest <digest> --trust dist/gh-autumnnazi.ssh-<版本>.zip
gonavi plugin --root ./devroot enable gh-autumnnazi.ssh
```

或在 GoNavi 桌面端「设置中心 → 插件 → 本地安装」选择 `dist/gh-autumnnazi.ssh-<版本>.zip`（开发验证也可选择 `package/` 目录）。

## Agent 工具（ai.tools）

清单声明了 `ai.tools`：全部 51 个命令进入 GoNavi Agent 工具目录（`plugin__` 前缀），
GoNavi 自带 MCP Server 时可被外部编码代理调用。写效果命令统一标 `side_effect_unknown`
走宿主审批；插件级只读模式只作用于这条通道——除巡检白名单（`readOnlyExecAllowlist`）
外禁止 Agent 执行命令，`agent.runBg` 直接拒绝。人工操作（连接、终端、文件、档案）
不受只读模式影响。

## 安全说明

- 密码、私钥口令、跳板凭据使用本机数据目录内主密钥 AES-GCM 加密存储；密钥文件 0600。
- 主机密钥 TOFU（含每一跳）：首次记录，变更拒绝并报新旧指纹；跳板后主机按逻辑地址记录。
- sudo 只允许白名单前缀且非交互（`sudo -n`）；命令执行输出限量 512 KiB。
- 命令响应、日志不含凭据明文；认证错误统一脱敏。
- 目录跟随（可选，默认关）会在会话建立后向远端 bash/zsh 注入一行 OSC7 上报钩子（`PROMPT_COMMAND` / `precmd`），只把当前工作目录回显回来；关闭该选项的会话不注入。注入是静默的：先写一行 `read -s`，由远端 shell 自己把下一行读走（读期间内核不回显），那段钩子根本不经过屏幕；插件显示层只剥掉那行 `read` 自己的回显（逐字节对得上才剥，对不上就原样显示，不会吞掉真实输出）。用户已经开始敲命令的会话让路不注入。该钩子随会话结束消失，不写远端任何文件、不改远端配置。注入用的那行 `read` 是当作你的输入敲进远端 shell 的，会被记进命令历史；钩子里顺手用 `history -d -1`（zsh 为 `fc -d -1`）把它删掉，所以按 ↑ 也翻不到插件的痕迹。

## 功能清单

**终端**
- PTY 多会话、同连接复用、窗口尺寸跟随
- 底部工具栏提供广播输入（同连接多会话同步）、常用命令菜单、Ctrl+C、复制与粘贴；支持亡会话回看。命令历史使用远端 shell 自带的 `history` 或方向键
- 交互认证（TOTP 等）弹窗应答；ProxyJump ≤3 跳；keepalive 探活
- 目录跟随（可选，默认关）：会话建立后自动注入 OSC7 钩子，远端文件面板跟随 `cd`（bash/zsh）；注入过程不出现在终端上。跟随时目录由终端决定，面板上的上一级 / 双击进目录 / 面包屑会锁住，先取消跟随才能自己翻
- 设置按终端、常用命令、安全与主机密钥分组，切换分类保留编辑内容；设置项改完即生效，文本域停手约 400ms 落盘
- 连接侧栏支持名称与地址搜索、批量选择、收起和宽度拖动；点击已打开的连接返回现有会话。连接侧栏和终端文件面板均支持键盘调整宽度、Escape 取消拖动和双击恢复默认宽度
- 终端页远端文件面板（可选，默认关）：终端左侧单栏远端目录（目录优先排序、双击进目录、首行 `..` 返回上级、面包屑跳转、手动刷新、超过一页时续页）。选中条目后可就地上传、下载、重命名、新建文件夹、删除，也可以把条目拖到底部「下载到」区下载——下载目录由系统目录选择器挑定后记住，传输交给后台队列（进度在「文件」页看）。插件窗口没有系统拖放能力，条目拖不到资源管理器，这是宿主限制
- 命令跳转：设置里配置「命令 → 目录」映射后，终端里**整行**输入 `#` 加命令名并回车（配了 `logs` 就输 `#logs`），远端文件面板切到对应目录（未显示的会临时显示，不改持久化设置）。前缀是必须的：不带前缀的行是你真的打在终端里的命令，插件不去猜；带了前缀又没命中映射也没有副作用——远端 shell 把 `#` 开头当注释，不执行也不报错。带上多余参数不算命中
- 本地回显（可选，默认关）：按键先画上屏，远端回显回来再逐字节抵消，高延迟链路下手感接近本地。判定保守——只在远端安静时预测、只预测可打印 ASCII（中文/IME、控制键、粘贴一律交给远端）、远端刚有输出或刚出现分歧的短时间内不预测；远端本就不回显的输入（`read -s` 密码、屏幕程序）会留在屏幕上，这是本地回显的固有代价，介意就把它关掉（改完当场生效，不用重开终端）。默认关，需要时在设置里打开

**认证与凭据**
- 密码 / 私钥（含口令）/ SSH Agent / 无认证
- Quick Sudo：档案级 sudo 密码（加密存储）自动注入，支持一次性动态码参数
- 主机密钥 TOFU（含每一跳）：变更拒绝并报新旧指纹；known_hosts 可在设置中查看/删除
- 凭据解密失败时保留原始密文，保存其他档案不会丢掉恢复机会；跳板凭据损坏也标记档案不可用。档案与设置写盘失败时回滚内存状态。

**SFTP**
- 双栏浏览（面包屑导航 + 前进/后退 + 路径编辑 + 磁盘用量），每栏通过一个来源菜单切换本机或服务器；文件按名称、大小、修改时间对齐显示，窄栏自动隐藏时间列
- 上传/下载：原生文件/目录选择器、进度/速率、取消、断点续传、原子替换
- 传输最多全局 4 项、每连接 2 项并行，最多 200 项未完成任务；跨服务器任务占用双方额度，同一目标串行写入。上传覆盖保留目标权限，新文件继承来源权限（Windows 本地文件没有 POSIX 权限，新建远端文件使用 `0600`）；失败或取消会尝试清理远端临时文件，清理失败会保留临时路径及错误详情。
- 目录分页复用最多 30 秒的有界快照；第一页刷新和文件操作会更新或失效缓存。
- 远端复制（服务器端流式）、重命名、新建、chmod、递归删除、小文件预览编辑
- 终端页左侧远端文件面板复用同一套传输与远端动作，下载目录可单独指定（两处面板同一份后端队列，不各养一套状态机）
- 行右键菜单：打开（内置预览编辑）、用本机程序打开、上传/下载、重命名、删除、新建、复制路径，以及「在终端中 cd 到此目录」。双击文件等同「打开」
- 传输队列可折叠，显示活动与失败任务摘要，展开后可查看全部任务；文件树启用目录跟随时仍可预览文件，切换连接后旧请求与待确认操作失效

**Agent 工具**
- `agent.exec` / `execSudo`（白名单）/ `execMulti`（≤10 主机并行汇总）/ `runBg` + `taskStatus` + `taskCancel` / `metrics` / `triage`
- 批量执行共享 512 KiB 原始输出额度，响应以 `truncated` 标记截断；后台运行任务最多 50 项。
- 命令超时包含 SSH 通道、PTY、Shell 初始化。初始化卡住时断开无响应连接以释放挂起操作；运行中超时先关闭该会话，500ms 后仍无法收尾才断开连接。
- `historyEnabled=false` 会立即停止并清除现有会话的插件历史记录，包括尚未提交的输入；远端 shell 自己的历史不受影响。
- 只读模式：只限制本条 Agent 通道——除巡检白名单外禁止 Agent 执行命令、`runBg` 直接拒绝；人工操作不受影响
- 危险命令确认门（force 二次确认）、本地路径边界

**宿主集成**
- 语言、亮/暗主题、配色与外观实时跟随 GoNavi 主程序（zh-CN / zh-TW / en-US / ja-JP / de-DE / ru-RU）；文件夹、文件与链接用语义图标颜色区分
- 从 GoNavi 数据库连接导入 SSH 隧道主机（非敏感字段，幂等）
- 关闭插件窗口自动断开本窗口建立的全部连接（宿主回调 + 启动兜底）

