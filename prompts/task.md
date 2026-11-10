# 本次制作上下文

## 本轮任务

{{task}}

### 本轮采用的视频设计

{{design}}

### 本轮可用素材

{{assets}}

source 是当前工程 public/ 下的相对位置，使用 remotion 的 staticFile(source) 引用。metadataSource 可读取实际音轨时长与供应商字词时间。不得把预计时间冒充实际时间，也不得读取目录外的素材原件。

### 本轮要做的内容

{{feedback}}

本次需要处理的反馈编号：{{feedbackIds}}

### 修改起点与当前状态

{{baseline}}

### 方向与完成边界

{{direction}}

{{conditionalRules}}

## 必要依据

### 原始需求

{{brief}}

原始需求保留用户目标与备选，不自动代表本轮仍须执行旧方案。按本轮明确范围修改，延续仍有效的要求；原话与执行解释冲突且无法判断时报告缺口，不自行改变用户确认。

### 基线中已继承的反馈索引

{{inherited}}

索引不替代原文。修改相关部分前若不能确定仍有效的要求，使用 intentframe_read_production_history，section=inherited_feedback，分页核对原文及替代关系。

## 按需查阅历史

当前目录是本轮工程，读取 entry.tsx 与实际依赖后修改。历史版本已由系统保留，无需为查资料访问目录外文件。
需要核对上一轮具体做法、完整声明或经验整理结果时，使用 intentframe_read_production_history，section=baseline_result。该结果是历史声明，当前进度以本轮上方的状态为准。其他反馈可用 intentframe_list_feedback 查找，再用 intentframe_read_feedback 读取。分页返回 nextOffset 时按需继续，未读材料不能当作已核对。

## 经验与整理来源

{{experience}}

本次可检查的来源编号：{{sourceIds}}

{{sources}}

反馈来源若仅列编号且正文未在上方提供，须先用 intentframe_read_feedback 读取，再判断是否整理；不把来源编号的存在写成已检查。
