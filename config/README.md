# 本机配置

本目录通过 JSON 文件统一管理 intentframe 的数据位置、独立工具信息与运行参数，由同一配置入口读取和校验。

## 初始化与生效

[example.json](./example.json) 是可提交的完整示例；同目录的 `local.json` 是唯一持久运行配置，不进入 Git。首次使用从仓库根目录执行：

```sh
# -n 保留已有本机设置，不用示例覆盖它。
cp -n config/example.json config/local.json
chmod 600 config/local.json

# 按本机实际位置编辑 local.json 后检查生效结果。
./scripts/intentframe doctor
```

配置目录和配置文件不能是符号链接；本机文件必须属于当前用户，权限为 `0600`。缺失、无效 JSON、缺少必填项、未知字段或不合法的值都会阻止启动，不自动回退到示例。运行中不热加载；修改后重新启动 CLI 或 MCP 服务。

`doctor` 返回配置文件位置、环境覆盖项名称、资产总目录、正式与测试区域、共享经验与备份位置，以及工具可用性和实际版本。启动入口目前依赖 macOS 自带的 `plutil` 提取 Node 路径，随后由 [统一读取入口](../src/config.ts) 完成全部校验；当前支持环境见[运行入口](../docs/maintenance.md#运行入口)。

旧版的 `toolchain.json` 已由本配置替代。迁移已有安装时，先创建本机配置，再将旧文件中的数据位置和工具信息带入对应字段；新增运行参数使用示例初始值。改配置不会移动作品、修改旧记录或安装工具，变更数据目录前须核对已有资产位置与记录关联。

## 配置项与作用

初始值统一见[完整示例](./example.json)。除工具归档校验值和可选的 providers 外，运行字段均为必填；不要把不适用的字段留空或填成 `null`。

| 配置项 | 作用与边界 |
| --- | --- |
| `dataRoot`、`backupRoot` | 长期资产总目录和同机备份目录。正式制作沿用总目录内原有布局，测试制作使用其 `testing/` 子目录；共享经验使用总目录内的 `experience/library/`。备份始终包含整个资产总目录。须遵守[数据位置与备份边界](../docs/data.md#固定存储位置)，修改位置不等于迁移已有数据。 |
| `tools.node`、`tools.codex`、`tools.restic` | 分别记录 `path`（可执行文件位置）、`version`（安装版本）、`source`（来源 URL）及可选 `archiveSha256`（下载归档的 SHA-256）。这些记录用于追溯安装来源，不自动下载或校验安装文件；环境覆盖工具路径时也应核对实际版本。 |
| `runtime.requestTimeoutMs` | 单次 Codex 协议请求的等待上限，例如初始化、创建线程或取回原记录；通用接入验证未指定整轮限额时也沿用此值。 |
| `runtime.productionTimeoutMs` | 制作与经验整理等待模型一轮结束的上限，与单次协议请求分别计时。示例为 30 分钟；达到上限后请求中断并核对原终态。 |
| `runtime.jobTimeoutMs` | 后台工作进程领取任务后的总执行预算，示例为 60 分钟；达到预算后提出停止，不把提出停止当作已经停止。 |
| `runtime.stopTimeoutMs` | 原生中断的确认等待及媒体进程退出的宽限时间。未取得可靠终态时保留未知；也限定工作进程等待短暂交接保护的范围。 |
| `mcp.toolTimeoutMs` | [命令行 MCP 客户端](../scripts/mcp-call.ts)等待一次工具调用的上限；其他客户端的等待设置由各自管理。 |
| `media.concurrency` | Remotion 渲染并发数，为正整数；按本机资源调整。 |
| `media.renderTimeoutMs` | 一次渲染与产物核对的等待预算，示例为 30 分钟；渲染与媒体命令可响应停止，打包和规格读取会在当前步骤结束后核对停止。 |
| `media.probeTimeoutMs`、`media.decodeTimeoutMs`、`media.previewTimeoutMs` | 分别限制媒体规格检查、全片解码检查和单张预览生成的子进程等待时间。 |
| `backup.commandTimeoutMs` | 单次 Restic 命令的等待上限，不是整个备份及恢复核对流程的总时限。 |
| `diagnostics.toolTimeoutMs` | `doctor` 读取每个工具版本的等待上限。 |

所有 `*TimeoutMs` 单位为毫秒，须为 `1` 至 `2147483647` 的整数，防止 Node 将超大数值当作极短计时器。后台提交只等待受理，查询只读取当前记录；客户端等待时间不再承担整片制作预算。模型、渲染与总执行预算分别设置，停止是协作式的，不能据超时推定原执行已结束，须按[中断与失败处理](../docs/workflow.md#中断与失败处理)核对。接入验证脚本额外预留 10 秒用于返回结果，不超过 Node 计时器上限。

更新已有安装时，按示例补齐 `runtime.jobTimeoutMs`、`runtime.stopTimeoutMs` 与 `media.renderTimeoutMs`，并核对原来的模型等待预算是否适用。保留实际工具与数据位置，重新启动客户端连接以刷新工具定义。已受理任务的工作进程会核对系统和运行配置是否与受理时一致，发生变化时不会悄悄按新条件启动。

路径允许绝对路径或相对于**仓库根目录**的路径，与启动时所在目录无关；不展开 `~`、环境变量或命令表达式。不能填纯空白、换行或空字符。所有入口采用同一解析规则。

## 临时环境覆盖

保留以下临时覆盖，便于隔离测试与指定单次进程的目标。优先级为：**显式环境变量 > 本机文件**；即使有覆盖，本机文件也必须完整有效。空字符串是错误，不表示使用默认值。

| 环境变量 | 对应配置项 |
| --- | --- |
| `INTENTFRAME_DATA_ROOT` | `dataRoot`，始终是资产总目录；测试任务保存在其中的 `testing/` |
| `INTENTFRAME_BACKUP_ROOT` | `backupRoot` |
| `INTENTFRAME_NODE_BIN` | `tools.node.path` |
| `INTENTFRAME_CODEX_BIN` | `tools.codex.path` |
| `INTENTFRAME_RESTIC_BIN` | `tools.restic.path` |

本项目的 MCP 客户端显式传递这五个路径，并核对服务返回的总目录与两个制作区域，避免 SDK 启动子进程时丢失隔离目标；其他参数从同一配置文件读取。改变配置前结束旧进程，避免父子进程在配置变更期间读取不同内容。

## 正式与测试入口

一个 MCP 连接同时支持正式和测试任务，启动时无需选择用途：

```sh
./scripts/intentframe doctor
./scripts/intentframe mcp
```

服务返回的 `assetRoot` 是总目录，`workRoots.production` 与 `workRoots.test` 是两个制作区域。外部 AI 根据用户要求在 `create_work` 中填写 `purpose`，后续按 `workId` 自动定位，不修改启动配置。任务用途与制作阶段的区别以[数据保存边界](../docs/data.md#正式与测试的保存边界)为准，调用示例见[工具使用说明](../scripts/README.md)。

从之前的用途切换方式升级时，删除客户端配置或终端中的 `INTENTFRAME_PURPOSE`，重启一次连接以刷新工具参数。该变量已停用，残留时会明确报错。以后无需为日常用途选择重启服务；已有作品、操作回执和用途未明的历史记录保留原位。

## 提示词与模型配置

`local.json` 的必填 `models` 管理项目 Codex 调用，结构与当前初始选择见 [example.json](./example.json)。`default` 同时填写 `model` 与 `effort`；`stages` 按环节覆盖其中一项或两项，未覆盖字段继承 default。模型标识和强度不写入业务代码或提示词。此配置不修改用户全局 Codex 配置，也不改变当前外部聊天使用的模型。图片、语音、音乐等生成供应商仍独立使用 `providers`。

当前初始选择是默认 Sol 6.1 / high，完整制作与独立内检覆盖为 Astra，视觉理解覆盖为 Terra 6.1；均继承 high。未来替换时只编辑本机文件对应值，重启 CLI/MCP。旧安装升级须从示例补上 `models`，不能以缺失字段静默沿用运行器默认。

| stages 键 | 对应实际调用 |
| --- | --- |
| `draft_review`、`draft_revision` | 草稿检查、草稿修改 |
| `design` | 视频设计，包含设计期间的素材判断与查找 |
| `production_assets` | 采用设计后的只读素材方案：选择、搜索、检查与生成决策；不直接生成文件 |
| `sample` | 无本轮反馈的样例制作 |
| `production` | 无本轮反馈的完整制作 |
| `feedback_revision` | 处理明确选定反馈的修改，包括内检提出的修复；优先于 sample/production |
| `internal_review` | 独立新会话检查成片、设计实现与材料覆盖 |
| `learning` | 独立经验整理 |
| `visual_understanding` | 图片附件、实际素材图片、成片拼图的理解，向设计/制作/内检提供观察依据 |

例如只将视频设计的推理强度改为 medium，在已有 `stages` 中加入 `"design": { "effort": "medium" }`；模型继续继承 default。未知键和空值会阻止启动。每次新推理先查询同一 Codex 运行器的模型目录，核对模型与强度支持情况，再显式传入 thread/start 或 thread/resume，以及 turn/start；返回模型或强度与请求不一致时停止，不降级、不自动重试。

`doctor` 与 `get_runtime_info` 返回已加载的 models；这是配置状态，不等于已完成推理。每次执行保存 `modelSelection`（环节及请求值）、`model` 与 `reasoningEffort`（运行器返回值）。新版本即使接续原线程，也显式设置本轮选择；恢复只读取原轮次，不用新配置重发。已受理后台请求把 models 纳入配置指纹，修改后未启动的旧请求会明确拒绝执行。

素材方案和视觉理解沿父任务串行运行，输入、输出与原生身份保存在作品的 `analysis/`。成片内检还会独立查看实际拼图，不自动接受视觉分析结论。只补材料、渲染恢复和 reconcile_only 不发起新推理。独立外部 AI 的审查与用户认可仍由外部入口记录，本项目不能替换外部聊天模型；本配置中的 internal_review 是项目提供的独立检查调用。

提示词正文和任务说明模板维护在系统仓库的 [prompts/](../prompts/README.md)，按执行用途组织。程序读取、选取适用部分并填入本轮数据，内容组织见[主 AI 的必要输入](../docs/workflow.md#主-ai-的必要输入)。接口校验与执行逻辑仍由代码承担；模板只作明确占位替换，缺失必要输入会报错。

通用提示词随系统版本维护，真实需求、反馈和每次实际输入保存在作品目录；来源与历史依据见[记录要求](../docs/data.md#制作输入与历史依据)。不能在本机配置中放真实任务内容，也不能在代码、提示词文件和文档中各维护一份相同长篇规则。

Codex 登录凭据继续由运行器管理，不写入项目模型配置、提示词和日志；历史模型及强度缺值保持未知，不按当前选择补造。模型目录和线程返回值只证明客户端可核对的配置，不证明隐藏的服务端路由。接口依据见 [Codex app-server 官方文档](https://learn.chatgpt.com/docs/app-server)。

## 图片与豆包语音

`providers` 可省略或为 `{}`，草稿与设计仍可使用。实际生成前在权限为 0600 的本机配置中填写对应项；真实调用按用户授权执行。不要把真实 Key 发进普通项目文档或提交到 Git。

以下仅说明可选字段，加入现有配置时保留原来的其他设置：

```json
{
  "providers": {
    "image": {
      "apiKey": "在本机填写真实 Key",
      "model": "接入时确认的 GPT Image 模型",
      "timeoutMs": 300000
    },
    "speech": {
      "apiKey": "在本机填写豆包 API Key",
      "speaker": "已有音色 ID",
      "resourceId": "已有音色对应的资源 ID",
      "model": "该资源实际需要的模型",
      "timeoutMs": 120000
    }
  }
}
```

`speech.model` 可省略，其他服务身份字段配置该服务时必填。服务端返回配置状态及可选音色编号和名称，不回显 Key。实际声线、资源、模型和调用预算在用户确认后填写；示例值不能用于真实调用。

`speech.label` 和 `speech.description` 可选，分别说明默认音色的可辨认名称、用户提供的身份与依据；其他音色的 `voices` 项也支持 description。外部运行信息和项目内部能力查询返回 id、label、description、configured，不返回凭据。明确身份声明在适用范围内沿用；未提供的身份保持未知，配置存在不代表实调或听感已验证。具体用户身份只写本机配置或作品记录，不固化在通用代码中。

使用复刻 2.0 音色并传入声音指令时，设置 `speech.resourceId` 为 `seed-icl-2.0`、`speech.model` 为 `seed-tts-2.0-expressive`。省略 model 默认使用标准模型，不能承接声音指令；项目会在发起调用前拒绝不兼容组合。声音要求随每次调用的 `voiceInstruction` 传递，不放入固定配置，具体用法见[素材调用](../scripts/README.md#图片配音与本机音乐)。

GPT 图片适配使用官方 Images API：无参考图调用 generations，有参考图调用 edits；目前每次一张 PNG、1024 方图、medium 质量。豆包适配使用 HTTP 单向流式 v3 请求，保留台词原文，接收 MP3 与服务返回的字词时间；语速为 -50 到 100。换用账号、音色或模型时须重新核对服务条件；当前实调范围见[能力状态](../docs/architecture.md#当前实现与下一步)。依据：[OpenAI 图片接口](https://developers.openai.com/api/docs/guides/image-generation)、[豆包 v3 文档](https://docs.volcengine.com/docs/doubao-voice/http-chunked-sse-unidirectional-streaming-v3?lang=zh)。

请求发送前保留本机身份，网络超时或响应不明不自动重试；明确失败也不会静默换供应商。恢复只核对原保存的输出。新凭据和服务条件进入后台配置指纹；排队期间改变配置会拒绝按新条件启动。

本机素材导入支持 PNG/JPEG/WebP 与 MP3/WAV/M4A/OGG/FLAC，单文件最多 128 MiB，图像最多 16,777,216 像素；实际类型和解码由媒体工具核对。网上下载同样支持这些格式，图片下载上限 32 MiB、音频 128 MiB，总时限 60 秒，最多三次重定向；普通文件地址可用，网页播放器、登录及提取接口未接入时会明确失败。没有新增杀毒、容器或统一重编码。

### 其他音色、音乐与音效生成

`speech.voices` 可选配置其他已有豆包音色，每项含 `id`、`label`、`speaker`、`resourceId`、可选 `model`。`id` 唯一且不能为保留值 default。调用时 `voiceId` 省略或为 default 使用当前默认音色；其余只接受已配置编号，使用同一账号凭据，不能通过工具传入凭据。实际服务权限与声音指令兼容性仍须核对，不提供声音训练或克隆入口。

音乐和音效分别通过可选 `providers.music`、`providers.sound_effect` 接入 ElevenLabs HTTP API，每项包含 `apiKey`、`model`、`timeoutMs`（默认 300000）。示例模型为 `music_v2_5` 和 `eleven_text_to_sound_v3`；接入时按实际账号核对。本机原配置未自动增加这两项，`config/example.json` 继续以空 providers 表示默认不启用付费服务。

音乐接收 prompt、3–600 秒 durationSeconds，以及 forceInstrumental（默认 true）；音效接收 prompt、0.5–30 秒 durationSeconds，以及 loop（默认 false）。输出请求为 MP3；时长和循环是生成要求，实际文件另行技术检查，不证明听感。未配置时在发送前拒绝；超时或不完整响应保持未知，已有完整响应可离线恢复，不使用新凭据重发。

接口依据：[音乐生成](https://elevenlabs.io/docs/api-reference/music/compose)、[音效生成](https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert)。配置存在不代表真实调用已经验证；验证状态见[当前实现](../docs/architecture.md#当前实现与下一步)。

## 本机素材库

可选 `assetLibraries` 指定项目允许检索的本机目录，默认 `[]`。每项有唯一 `id`、绝对路径或相对仓库的 `path`，以及 `role`（reference/image/narration/music/sound_effect）。可选 `roleOverrides` 按库内文件或子目录的相对路径覆盖用途，最长的完整路径匹配优先；路径不能越界或重复。这样可以保留原分类，同时单独检索音效。目录只读，跳过符号链接；选择后复制入作品，源文件不移动。实际素材位置只在私有配置登记。

可选 `usageNotes` 保存用户对该库的使用声明及依据，例如已确认可商用；`attributionPaths` 列出需要署名的库内相对目录或文件，按完整路径边界匹配，可为 `[]` 表示该库未要求署名。未配置不从目录名推断许可或署名要求。声明和提醒通过素材检索、导入、复用及版本摘要返回；历史保存内容与当前配置说明分别表达。使用规则统一见[素材来源与使用说明](../docs/data.md#素材来源与使用说明)。

```json
{
  "assetLibraries": [
    {
      "id": "background-music",
      "path": "../intentframe-data/library/music",
      "role": "music",
      "roleOverrides": [{ "path": "自然-特效", "role": "sound_effect" }]
    },
    { "id": "shared-images", "path": "../intentframe-data/library/images", "role": "image" },
    { "id": "shared-narration", "path": "../intentframe-data/library/narration", "role": "narration" }
  ]
}
```

修改配置后重启已有 MCP 连接。运行 `./scripts/intentframe index-assets` 建立或刷新总数据目录的 `library/index.json`；该命令只读取文件并计算摘要，不解码、试听或联网。索引内容、过期处理和作品副本的分工见[共享素材库与索引](../docs/data.md#共享素材库与索引)。

自动听音已按用户要求移除；项目只提供音频元信息、字词时间及试听文件，不配置音频理解模型，也不把音频内容传给制作和审查模型。听感保持未检查，用户可通过本机音频确认。

制作与设计使用运行器原生网上搜索；实际可用性取决于运行器及账号。下载工具仅保存已找到的公开 HTTPS PNG/JPEG/WebP 图片，检查地址、大小和实际解码，保留来源；不提供自建搜索服务。素材库设置纳入配置指纹，已排队任务不会悄悄采用后来的配置。

## 维护与验证

新增可调参数时，同步更新示例、统一校验、实际使用处及本页说明，并用隔离用例验证生效与错误行为。业务确认规则、恢复保护、媒体交付格式等约束继续由对应实现与设计文档定义，不提供配置开关绕过它们。JavaScript 库版本仍由 [package-lock.json](../package-lock.json) 锁定。

本配置接受运行参数及下述可选生成服务设置。第三方 API Key 仅保存在本机私密配置中，不写入提示词、源码或普通日志；不保存账号登录密码或真实任务内容。Codex 沿用其原生认证；Restic 密码继续由[现有备份流程](../docs/data.md#存储与备份边界)管理。本机配置及常见编辑器备份文件已被 Git 忽略，但本机系统备份仍会包含该配置，恢复时也须核对文件权限和位置。

[配置回归](../tests/config.test.ts)检查文件与参数拒绝行为、环境覆盖、工作目录无关的路径解析，以及实际启动和 MCP 子进程使用的配置；测试在临时目录运行，不改真实本机配置或作品。全部系统回归的命令、前提和证据边界见[系统回归](../docs/maintenance.md#系统回归的范围)。
