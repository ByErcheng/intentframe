# 视频制作模型比较

目标：比较模型在 intentframe 各环节的质量、稳定性、耗时和用量，展示实际结果后由用户选择。首轮配置为 Sol 6.1、Astra、Terra 6.1，均为 Medium，保存在可修改的[本轮输入](config/round-01.json)；通用代码不内置这些模型或默认强度。模型选择不等于成片认可或发布授权。

作品规格随冻结输入与轮次 `media` 指定。首轮为 **480 秒、9:16、1080×1920**；一分钟强度示例为 **60 秒、9:16、1080×1920**。旧配置未提供 `media` 时，基线校验沿原480秒规格兼容。基础草稿检查不要求先渲染完整影片；设计、制作、审查和修改使用对应轮次的实际任务和媒体。时长本身不是难度证明。合成案例只证明所测场景，不代替真实委托或长期稳定性。

## 案例与阶段

[执行清单](suite.json)是输入、操作和评价维度的唯一映射。每个案例只读确切单项文件，不再从一个混合文件人工选段。

| 阶段 | 案例及内容 | 比较范围 |
| --- | --- | --- |
| 草稿检查 | [基础错误](inputs/drafts/basic-correction.md)、[未决定意图](inputs/drafts/open-decision.md)、[正常对照](inputs/drafts/clean.md)、[复杂资料](inputs/drafts/commute-review.md) | 原话对照、隐蔽推断、事实时态、漏报/误报、问题归属；简单例只作底线检查 |
| 辅助改稿 | [基础改稿](inputs/drafts/revise-basic.md)、[复杂改稿](inputs/drafts/commute-revise.md) | 同时纠正多处错误并保留有效表达，不以删除整段规避问题 |
| 视频设计及设计中的素材判断 | [生活叙事](inputs/market.md)、[通勤解释](inputs/commute.md) | 长篇组织、跨段连续性、统计与因果解释、竖屏表现、检索与资源判断 |
| 初次制作及制作中的素材决策 | [固定共同设计](inputs/designs/commute.md) | 所有候选使用同一设计、台词与条件；素材与代码决策可不同 |
| 素材准备专项 | [采用设计后的检索与生成](inputs/asset-decisions.md) | 同一图片服务与一张图预算；实际检索、导入、查看并说明分层及声音未检查范围 |
| 内部审查 | [共同设计](inputs/review.md)及清洁/缺陷两个实际版本 | 检查正常对照、漏报、误报与补帧，不提前给出问题定位 |
| 反馈修改和内部修复 | [同一反馈](inputs/feedback.md)及共同缺陷工程 | 原问题、新增缺陷、正常部分和音频保留、首稿及修复成本 |
| 经验整理 | [原始来源记录](inputs/learning/records.md) | 条件冲突、证据范围、旧候选修正、一次性要求、缺失来源 |

设计与素材判断属于一次设计调用，制作与素材决策属于一次制作调用。它们分维度评价，不伪装成独立调用。生产链会自动内检修复：执行入口保存每版和首个产物，首次制作单独比较，最终结果另列为同一配置的完整流程表现。独立审查使用 `inspect_only` 调用现有 ReviewService，不触发制作修复。

## 当前完成状态

已具备案例、共同制作设计、参数化计划/输入快照、真实运行入口、配置核对、调用预算、结果展示及用户选择记录。运行入口复用 WorkService、AuthoringService、ReviewService 和既有 Codex app-server。产品现已支持[按环节配置](../../config/README.md#提示词与模型配置)；比较入口显式将本候选模型与强度用于全部内部调用，避免混入日常配置，仍不写本机配置或自动选档。当前新增的素材方案与视觉理解调用也计入本候选；与旧系统轮次比较时必须列明流程差异，不能覆盖历史系统快照。

具体轮次是否已调用模型、基线是否就绪、哪些结果已评价，以本机测试目录中的输入、回执、核验和用户选择记录为准，不在通用说明中固定为“尚未执行”。图书室清洁/缺陷基线、审查材料和经验来源按[基线准备规则](evaluation/baselines.md)建立并核验；缺少绑定时会在模型调用前拒绝。文本/设计/指定设计制作可以建立明确标识的合成上游前提，只测试目标阶段，不据此宣称真实用户已交接、上游模型有效或成片已采用。

模型文件读取范围收窄到本候选的数据目录，评价文件不复制进去。该范围设置和拒绝行为有模拟协议回归；真实运行的有效权限、拒绝与工具兼容证据随具体轮次保存，不外推到未测试环境。基线打包者须排除答案、评价、其他候选输出及既有模型审查，不能把目录分开放置当作自动隔离。原生载入的指令路径、实际使用素材和未受控来源保留在证据中。

## 准备与执行

在仓库根目录使用项目已配置的 Node（本机需把 `intentframe-tools/bin` 加入 PATH）。通用配置中的模型、强度、案例范围和重复次数均由输入控制；修改配置后另开轮次，不覆盖旧记录。首轮每例每候选一次用于观察，关键结论按配置中的 repeatRule 等量复测。

```sh
# 只校验并查看计划，不写任务、不调用模型。
node scripts/model-evaluation-plan.mjs plan tests/model-evaluation/config/round-01.json

# 父目录须存在，目标目录须为仓库外尚不存在的新目录。
node scripts/model-evaluation-plan.mjs prepare tests/model-evaluation/config/round-01.json /absolute/local-testing/new-round

# 下面这条才执行指定案例，会使用模型和配置允许的素材生成额度。
node scripts/run-model-evaluation.ts run /absolute/local-testing/new-round run-实际编号

# 审查、修改或经验整理必须提供相同的已核验基线绑定。
node scripts/run-model-evaluation.ts run /absolute/local-testing/new-round run-实际编号 /absolute/local-testing/binding.json
```

`prepare` 冻结案例正文及摘要、配置、运行编号和顺序，分配独立候选目录；`run` 核对冻结正文、清单、系统指纹、运行脚本、资源配置和共同基线，条件变化拒绝同轮继续。基线必须是独立的单作品 `purpose=test` 数据快照，实际文件的目录摘要通过 `snapshot-hash <目录>` 获得。[绑定格式](config/baseline.example.json)中的核验记录由实际检查者填写；反馈修改额外提供 `feedbackIds`。经验基线须已有可追溯、未整理的来源记录，不能只提交四行文字当成工程历史。

通过 [exportBaseline](../../scripts/model-evaluation/baseline.ts) 导出新流程作品时，先核对原稿件及其入项检查。副本保留确切草稿已通过的最小前置事实和来源摘要，原检查正文、反馈及模型回答不进入候选输入，也不伪造一次新模型检查。该依据仅供测试副本的原草稿使用；新稿仍须检查，后续实际检查失败优先于导出事实。旧流程没有检查记录时保持原兼容规则，不补认历史检查。导出只准备基线，媒体核验与比较评价仍须单独完成。

运行器先查询实际模型目录，核对所输入的强度是否受支持，再在新线程及轮次中显式传入模型与强度；文件边界使用命名权限配置，并核对实际生效的 profile。旧的 `readOnly.access` 字段已被实机拒绝，不再使用。独立审查额外禁止读取版本源码、任务记录和反馈目录。有效模型、强度或权限配置不符或缺失时，不发送生成轮次；回执不代表服务端内部路由可知。依据为[官方 app-server 文档](https://learn.chatgpt.com/docs/app-server)、[权限配置说明](https://learn.chatgpt.com/docs/permissions)及本机生成的实验协议类型。

### 执行条件与失败处理

- 配置中的 `limits` 是本轮显式预算。`modelTurnMs` 限制单次模型等待；`operationMs` 用既有中断机制限制整个操作；`generationCalls` 限制本案例所有内部轮次的素材生成工具调用尝试。它不是金额预算，也不包括未知服务端计费；未知调用不重试。
- `mediaProbeMs`、`mediaDecodeMs`、`mediaPreviewMs` 可覆盖当前测试进程的媒体预算，缺省沿项目配置，不写本机配置。8 分钟的计帧与解码可能超过短样例预算；工具超时要与模型内容失败区分，不能通过降低检查标准或增加推理强度处理。
- 首轮输入允许图片与配音生成，音乐/音效生成不启用；可通过输入改变。实际服务身份快照保存但不包含 Key，配置变化拒绝混入同轮。未配置服务按缺口报告，不归为模型能力差。
- `assetLibraries` 可传本机库编号列表，或 `configured` 使用当前已配置库；空数组不使用本机库。首次执行记录库配置与已有索引摘要，变化时拒绝混入同轮。原文件仍只读，实际导入素材沿项目保存副本、来源和摘要；配置与索引相同不证明所有库文件完全不变，评价时核对实际用到的素材。在线检索同样保留实际来源和条件，不宣称外部结果完全受控。
- 每次实际调用保留 `execution.json`、`runtime.jsonl`、`result.json` 和候选工程。参数、有效配置、原生执行身份、终态、用量事件及生成调用次数分开保存。总耗时含工具和渲染，不冒充纯推理时间；费用未知时不猜测。
- 同编号已有执行尝试后禁止直接再跑。失败、未知和未完成都保留；沿既有项目恢复机制核对原线程/回执，恢复前不得删除标记或换号重复未知调用。该脚本没有自动重试或自动恢复命令。
- 整个入口在本机前台运行，复用核心业务服务，不经过外部客户端的后台受理链路；它不证明客户端接入与断线交接。执行时保持进程存活，退出或失联不自动报告成功。

已知媒体检查失败且原成片仍可靠可用时，可通过 `node scripts/continue-model-media.ts <轮次目录> <运行编号> <媒体预算.json>` 显式接续内检和原流程修复。该入口拒绝未知执行和非媒体失败，沿原模型、强度及剩余生成预算；原结果、首稿和失败不覆盖，新证据写入 `continuation-*` 文件。它不是自动重试，也不能把缺失的当时媒体或源码证据补造出来。

素材专项通过清单中的 `prepare_assets` 操作执行，复用制作阶段工具和请求保护；只开放能力核对、检索、检查、复用与图片生成，不开放视频编写、渲染或试听。配置仍由轮次输入提供；本案例限定一张图，应设置 `generationCalls: 1`。完成状态表示素材目标完成，保留的占位视频版本明确标记未制作。图片是否满足要求须实际查看，不能用生成回执代替。

## 展示、评价与选择

```sh
node scripts/model-evaluation-plan.mjs report /absolute/local-testing/new-round
# 也可只看一个案例。
node scripts/model-evaluation-plan.mjs report /absolute/local-testing/new-round design-commute
node scripts/model-evaluation-plan.mjs choice /absolute/local-testing/new-round /absolute/local-testing/user-choice.json
```

报告使用匿名候选标签并链接文本结果和实际存在的视频，区分未开始、未知、失败、首稿与后续版本。先依据[评价标准](evaluation/criteria.md)和[评价模板](evaluation/review-template.json)检查产物；原始 `result.json` 含模型身份，应在盲评后再看。模型自己通过内检不代替独立质量评价。

用户回复后，由调用方把原话与确切运行编号写入[选择输入](config/choice.example.json)，标签映射回配置中的候选编号。记录支持单选、并列、暂缓、全部不合适，保存结果文件摘要且不覆盖旧选择。程序只核对引用和格式，不自动推断用户意图或代填认可。

选型后，在未参与调试和选择的新题材上复核，再比较用户选中模型的推理强度；必要时验证不同环节组合。新案例须另建冻结输入和相同评价规则，不能把当前案例的答案变成制作经验后再声称迁移有效。此阶段依赖用户选择，当前不预先替用户确定组合。

## 一分钟四档强度示例

模型选择已经由用户明确时，可以按职责分别建立轮次；仍使用同一个计划和执行入口，不新增产品模型路由。示例输入位于[一分钟题目](inputs/one-minute/brief.md)，评价主定义见[一分钟评价依据](evaluation/one-minute.md)。四档为 `medium`、`high`、`xhigh`、`max`，由各轮JSON指定；运行器仍逐档查询支持范围并核对实际配置，不回退为默认值。

| 轮次输入 | 目标与职责 |
| --- | --- |
| [Sol文字环节](config/effort-sol-authoring.json) | 复杂草稿、正常对照、未定意图、改稿、设计与设计中的素材判断 |
| [Astra制作](config/effort-astra-production.json) | 同一60秒六段脚本和配音原文；首稿与自动修复另列 |
| [Astra审查](config/effort-astra-review.json) | 同一个未受控注入版本及两项受控缺陷版本 |
| [Sol素材](config/effort-sol-assets.json) | 本机检索、导入、单张图生成与实际查看 |
| [Sol修改](config/effort-sol-feedback.json) | 同一工程、同一反馈及原声音；基线要求由清单的 `fixed_feedback` 声明识别 |
| [Sol经验整理](config/effort-sol-learning.json) | 有来源的合成历史条目，不冒充真实成片迁移 |
| [Terra视觉理解](config/effort-terra-visual.json) | 只读同一实际视频的七张截图，不给设计数字答案，不调用成片内检 |

这组示例共12案例、48组，不把旧8分钟的Medium结果当作新一分钟对照。实际用户选择、对应历史运行和原话保存于本机轮次，不写全局配置。视觉理解通过 `inspect_visuals` 执行，只准备材料和调用视觉模型；素材、成片独立审查与反馈流程里的自检分别记录。基线准备与实际核验先完成，再运行依赖基线的项目；文件存在不能替代内容核验。

各轮继续用上面的 `prepare` / `run` 命令。真实输出先展示冻结输入，再展示各档原文、图像与视频文件夹，允许用户自行观看、试听后选择。一次观察不自动认定“更高强度更好”，失败与未完成不删除。

## 验证入口

```sh
node --test tests/model-evaluation-plan.test.ts tests/model-evaluation-runtime.test.ts tests/model-media-continuation.test.ts tests/model-asset-phase.test.ts tests/model-effort.test.ts
node node_modules/typescript/bin/tsc --noEmit
node --test tests/*.test.ts
```

定向回归使用临时目录与模拟运行器，检查模型和强度动态传递、不支持/不一致/缺值时不生成、输入快照与路径隔离、预算拒绝、未知不重发、技术接续、素材工具范围、结果展示和选择记录。真实 8 分钟媒体、实际语义效果、真实沙箱兼容、供应商结果及模型优劣，以各轮本机实测证据为准；代码回归不证明这些结论。当前验证结果见项目[运行与验证](../../docs/maintenance.md#模型比较测试文件)。
