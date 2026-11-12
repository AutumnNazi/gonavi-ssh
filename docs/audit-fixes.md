# 本轮审查修复

基线：`origin/main` 的 `7c96aac`（v0.1.7 界面重整），工作树 `.worktrees/audit-fixes`，分支 `codex/audit-fixes`。
2026-11-12 已重新 fetch 并核实远程 main 未变化。工作树已完整同步该提交，再合入本轮审核修复；
新版连接搜索、可收起/调整宽度的侧栏、设置分组和文件界面均保留。
主工作区原有四项前端改动已包含于上游新版，主工作区本身仍未修改。

此前包的原因：工作树仍基于 v0.1.6，仅改版本号与四项本地前端改动没有同步完整 v0.1.7 界面。
浏览器回归现明确检查上述新版交互，并支持通过 `UI_ASSET_ROOT` 加载最终 ZIP 解包资源；
旧前端在“新版连接搜索缺失”断言处失败，避免再次仅凭页面可打开就通过验收。

| 范围 | 结果 | 主要回归 |
| --- | --- | --- |
| 文件预览 | 加载完成前禁止编辑保存；连续保存、切换文件和迟到响应互不影响 | FilePreviewModal 测试、真实浏览器连续保存 |
| 凭据恢复 | 保留不可解密密文，标记损坏跳板，阻止不完整档案连接，编辑时保留不可见跳板 | profile/recovery、sshclient/corrupt_profile、server/corrupt_profile、ProfilePanel |
| 持久化 | 档案增删改和设置写盘失败时回滚内存 | profile/recovery、settings/persistence |
| 文件传输 | 保留权限；Windows 新上传默认 0600；取消/失败回收临时文件，清理错误保留路径 | transfer/permissions |
| 传输调度 | 全局 4、每连接 2、未完成任务 200 上限；同目标串行；跨服务器占用双方额度 | transfer/queue |
| 命令执行 | 批量输出共用 512 KiB 预算并标记截断；初始化和运行均受超时控制；超时退役清理连接索引与资源 | agentcmd/lifecycle、sshclient/session_retirement |
| 后台任务及历史 | 运行任务上限 50；关闭历史立即停止采集并清空已有和未完成输入 | agentcmd/lifecycle、terminal/history_settings |
| 终端目录 | 按会话保存目录；文件页校验连接归属；使用 xterm OSC 流解析器 | App、SftpPanel、TerminalView |
| 终端读取 | 最多 32 会话一批，超过一批时轮转并缩短等待，仍只有一个在途读请求 | terminalWriteQueue |
| 大目录分页 | 有界 30 秒快照；第一页强制刷新并淘汰旧快照；变更使缓存失效；旧请求不能覆盖新快照 | sftpops/listing_cache |
| 可移植构建 | 固定 SDK 原始源码快照及许可证，移除本机绝对路径依赖 | go test、三平台组包 |
| 验证入口 | npm test、自动启动的真实浏览器检查、失败退出码、GitHub Actions | frontend-test、ui-smoke、package.test |

按用户决定暂缓：只读模式的可信调用来源隔离。当前宿主协议没有提供来源信息，本轮没有改变该策略。
功能扩展清单（目录传输、档案分组等）不在本轮范围。

注意：SSH 初始化超时会关闭该无响应连接；运行中命令先关闭会话，无法及时结束时再关闭连接。
此 Windows 环境未安装 C 编译器，因此本地不运行 race 检查；远程 Linux 工作流的 `go test -race ./...` 和 vet 已通过。

## 同步新版后的验收（2026-11-12）

- 本轮修复基于 `origin/main` 的 `7c96aac`，无未解决冲突；推送前审查新增问题均已修复并回归通过。
- 前端测试 275 项全部通过，TypeScript 检查与 Vite 构建通过；Go 全包测试与 vet 通过。
- 打包回归 13 项全部通过、无跳过；Windows amd64、Linux amd64、Darwin arm64 三平台构建成功。
- 从最终 ZIP 解包启动真实浏览器：新版连接搜索、侧栏收起/展开、设置分组、文件列头、加载期保存保护与连续保存均通过，无浏览器错误。
- ZIP 内全部 8 个文件与 `package/` SHA-256 一致，4 个前端文件与 `frontend/dist/` SHA-256 一致；实际 ZIP 通过宿主 `InspectPackage`，与目录内容 digest 一致。
- 新版前端资源：`index-rdE2b9o9.css`、`index-BhimHjAA.js`。

## 推送前复审（2026-11-12）

复审发现并修复两项 P2；新增回归均先复现失败，再验证修复通过：

- 目录刷新后因超限或并发失效而不缓存新结果时，下一页可能复用旧快照；现每次新读取前淘汰该目录旧快照。
- SSH 初始化或命令取消超时直接关闭连接，原来会跳过管理器索引及 SFTP 清理；现所有关闭路径统一幂等退役，按连接对象校验索引，锁外异步清理资源，保留已重连的新连接。

修复后的 Go 全包测试、vet、三平台组包、最终 ZIP 浏览器验证与宿主验包再次通过。
原前端 275 项与打包 13 项结果仍适用；本次补修未改变前端与打包逻辑。
首次启用 Linux CI 还暴露了旧测试的平台假设，已修正测试而不改变生产行为：
路径白名单按宿主系统验证盘符与大小写；文件时间用本地日期构造测试输入，不再写死 `+08:00`。
ZIP 测试在 Linux 使用 `zip`/`unzip`，避免把 Windows bsdtar 的 ZIP 能力套用到 GNU tar；Windows 仍使用系统 bsdtar。
前端在 UTC 环境下 275 项通过，文件树在上海时区 36 项通过。

交付包：`dist/gh-autumnnazi.ssh-0.1.7.zip`（7,770,001 字节）。

ZIP SHA-256：`74DA328D3E2655C2F1B8A14545A949340D2FE238E4FB838CE7EE82670183BFB0`。

宿主内容 digest：`acc510200e69b5442f774e317b2c81c6cc068de388c8839a2d574be5cd381924`。

本地验收记录：`output/release-verification.json`；界面截图：`output/playwright/ui-smoke.png`、`output/playwright/ui-settings.png`（使用模拟连接数据）。
