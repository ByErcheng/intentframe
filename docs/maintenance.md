# 运行与验证

本页维护系统启动、回归和真实接入验证的命令、前提与范围。能力状态统一见[当前实现与下一步](./architecture.md#当前实现与下一步)，具体作品与执行证据从[本机数据入口](../../intentframe-data/README.md)查阅。

## 运行入口

首次使用先按[本机配置](../config/README.md)初始化配置文件。工具位置与来源、数据位置和运行参数通过同一配置入口管理，库版本由 [package-lock.json](../package-lock.json) 锁定。当前环境为 Apple Silicon Mac；独立工具安装在 `/Users/yan/ercheng/intentframe-tools/`，没有修改系统全局 PATH。

```sh
# 检查工具和数据入口
./scripts/intentframe doctor

# 启动本机 stdio MCP
./scripts/intentframe mcp

# 直接调用同一套工具，参数来自 JSON 文件
./scripts/intentframe call get_work /绝对路径/任务参数.json

# 类型与业务规则检查
export PATH="/Users/yan/ercheng/intentframe-tools/bin:$PATH"
npm run check
npm test

# 本机备份、恢复到新目录并逐文件核对
npm run backup:local
```

命令行 MCP 客户端为 [mcp-call.ts](../scripts/mcp-call.ts)，使用配置中的 Node 执行：

```sh
/配置中的/Node路径 scripts/mcp-call.ts <工具名> <输入JSON文件> [输出JSON文件]
```

日常调用、请求准备与恢复见[外部 AI 使用说明](../scripts/README.md)。[VS Code 配置](../.vscode/mcp.json)提供启动命令；配置存在不代表客户端已经发现、信任或接通服务。

## 工具与依赖管理

- Node 24.22.1、Codex 0.163.0、Restic 0.19.1 使用固定工具位置。Node 与 Restic 下载时核对了官方 SHA-256；Codex 通过固定版官方 npm 包安装。
- Remotion 及其配套打包、渲染与 Mac 媒体工具统一使用 4.0.541，React/React DOM 为 19.3.1。FFmpeg/ffprobe n7.1 随媒体工具提供，运行环境仅对相关工具生效。
- 渲染浏览器由 Remotion 下载和管理；其他工具按任务需要增加。
- JavaScript 依赖可用 `npm ci --ignore-scripts` 复现，首次渲染前须准备 Remotion 所需浏览器。工具路径变化先查配置并运行 doctor 检查，不依赖应用内部缓存目录。

## 系统回归的范围

`npm run check` 检查源码、脚本和测试的类型；`npm test` 使用合成测试材料和本地模拟的 Codex 响应，不消耗模型额度。媒体与备份回归实际使用已安装的 Remotion 浏览器、FFmpeg 和 Restic，需要上述 Apple Silicon Mac 环境、已安装依赖和已准备的渲染浏览器。临时目录由测试清理，经筛选需保留的执行证据按[系统测试记录](./data.md#系统测试记录)保存在本机。

| 回归入口 | 实际检查范围 |
| --- | --- |
| [配置](../tests/config.test.ts) | 配置文件与字段校验、临时覆盖、实际启动路径、跨进程配置及自定义运行时限的生效。 |
| [任务用途与定位](../tests/work-routing.test.ts)、[MCP 客户端](../tests/mcp-client.test.ts) | 同一连接交错处理两类任务、用途必填、后续按编号接续、跨用途重试冲突、旧区域回执与恢复，以及历史用途不明或记录冲突时的保护。 |
| [后台执行与指南](../tests/background.test.ts) | 连接指引与指南原文、短调用受理、断线接续、未开始取消、进程崩溃、停止终态、总预算、渲染恢复和未知保护；使用模拟模型，并实际调用 MCP 与本机媒体工具。 |
| [记录与流程](../tests/workflow.test.ts)、[制作服务](../tests/work-service.test.ts) | 多次审查与确认的历史保留、旧记录兼容、原文和路径归属、连续反馈、部分完成或失败后的草稿接续、确认样例与制作基线关系，以及失败与未知状态保护。 |
| [制作历史交接](../tests/production-history.test.ts) | 本轮任务优先、原始需求保留、历史材料冻结与分页、动态工具实际查阅、跨任务和任意路径参数拒绝，以及长反馈未读取时不能声明完成；模型响应为本地替身。 |
| [反馈证据](../tests/feedback-evidence.test.ts) | 被拒绝的应用声明不进入查询或排除待办，缺少工程时不确认应用，已核验的部分修改与后续继承分别展示；未读反馈不推进经验整理或保存候选，恢复不能补认读取，实际读取后允许推进。 |
| [提示词组装](../tests/prompts.test.ts) | 章节边界、缺失和重复标题拒绝、阶段互斥与条件选取、同文件多章节的来源摘要、制作和整理的实际消息位置及历史输入保留。 |
| [重复操作与定位](../tests/operations.test.ts)、[恢复](../tests/recovery.test.ts) | 同编号重试与冲突、并发和缺失回执、局部反馈范围、原结果补存、原线程核对、回执身份不符时禁止重发、仅补存时保留历史完成与认可，以及遗留占用与工程变化时的保护。 |
| [经验整理](../tests/learning.test.ts)、[比较](../tests/comparison.test.ts) | 共享经验的来源及版本、无效撤销与版本更新不破坏搜索、实际动态工具调用、明确拒绝后的状态与待办保留、部分整理和中断接续、补存后的当前状态及历史失败保留；比较的共同输入、派生任务长度边界与历史读取、知识范围、暂存发布和评价的增量整理。 |
| [运行器协议](../tests/codex-client.test.ts)、[MCP 客户端](../tests/mcp-client.test.ts)、[接入脚本](../tests/handoff.test.ts) | 执行结果与记录保存异常、跨进程的配置和任务交接，以及接入验证入口在模拟故障下的行为。 |
| [媒体](../tests/media.test.ts) | 实际渲染、帧率与解码、工程和成片的对应关系、丢失文件恢复、单帧视频预览，以及预览缺失或为空时仅从原视频补图、失败可见且保留认可。 |
| [请求与方向](../tests/request-guidance.test.ts)、[后台交接](../tests/production-handoff.test.ts) | 旧双方向基线与反馈歧义、未知中间版本不能传递确认、明确沿已确认旧样例接续；实际 MCP 拒绝前置条件与后台预览修复，不重复模型调用。 |
| [备份](../tests/backup.test.ts) | 真实 Restic 备份与恢复；核对清单、内容和权限，模拟数据变化或作品操作占用，检查是否会误报一致性验证通过。 |

正式运行与验证遵循同一套交接和失败判定规则，避免验证环境与实际行为脱节。用例按行为要求定义输入与预期，覆盖连续状态变化和跨进程交接，并检查实际记录与文件；工具正常退出或类型检查通过不能单独证明交付成立。上述回归不证明模型实际完成了反馈中的语义修改，也不替代[本机制作验证](#本机制作验证)。

单独复查反馈应用与整理证据时，在上述工具环境下运行 `node --test tests/feedback-evidence.test.ts`。该入口使用临时合成工程、模拟 Codex 和媒体替身，检查结果交接、查询和恢复记录，不调用真实模型或证明反馈的语义修改效果。

## 本机接入验证

文本接入测试已验证 MCP 调用、原会话恢复、新会话接续，以及部分明确失败与未知状态保护。实际执行记录仅保存在本机，位置见[系统测试记录](./data.md#系统测试记录)。

[接入验证入口](../scripts/test-local-handoff.ts)与正式运行使用相同的交接和失败判定规则，其异常场景纳入[系统回归](#系统回归的范围)。单独运行时，`--errors` 通过已配置的 Codex 检查异常处理；默认运行会使用现有 Codex 登录执行三个小文本任务。

## 本机制作验证

已通过简单图文任务验证本机制作、反馈修改、新会话接续和针对版本的用户确认。具体作品、版本、原始反馈、执行证据及认可状态从[本机数据入口](../../intentframe-data/README.md)查阅，不复制进系统仓库。

制作验证与故障回归只覆盖各自的任务和条件。音频、多素材工程、远程素材与动态加载、跨机器迁移、真实执行中断的自动核对恢复，以及 ChatGPT 原生工具注册仍待验证。
