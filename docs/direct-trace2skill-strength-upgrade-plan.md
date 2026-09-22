# Direct trace2skill 分强度升级实施计划

> 状态：Grill 已完成，可进入开发拆分与实现  
> 目标代码库：`/root/yjn/test-agent/memmy-agent`  
> 基线分支：`v1.1.7-trace2skill`

## 1. 改造目标与边界

本次改造基于现有 Direct trace2skill 链路，把“一个 Cluster 一次生成一条整体 Skill”升级为两阶段系统：

1. **构建阶段**：从同一 Cluster 的正、负轨迹片段中提取多个独立 Module，为每个 Module 确定固定强度，并封装为一个 Skill Package。
2. **运行阶段**：任务开始时选定一个 Package；任务过程中根据事件从该 Package 选择 Module，临时组合成 SOP 后注入 Agent。

此次只升级 Direct trace2skill，不改造通用记忆体系，也不复用 L2/L3 Memory、Policy、World Model、Skill Trial 等其他记忆链路。允许复用的公共能力仅包括：Episode、Cluster、LLM、Embedding、Worker、Storage 和 Agent Hook 等基础设施。

当前阶段明确不做：

- Package 的增量更新、跨 Cluster 融合和版本迁移；
- Module 强度的运行时升级或降级；
- 一个任务内切换 Package；
- Agent 自动执行 L4 修复工具；
- Goal 模式和 `goal_continuation` 的 Package 锁定、事件检索与状态续接；首版对这类内部 turn 直接跳过 Direct Skill Runtime；
- 面向所有 Agent Adapter 的一次性接入；首版只接入 `App/memmy-agent`；
- 为大量边界情况增加预留模块、复杂参数或通用规则引擎。

## 2. 核心对象与职责

### 2.1 Cluster、Package、Module、SOP

- **Cluster**：相似训练任务轨迹的集合，是现有聚类结果。
- **Skill Package**：一个 Cluster 的构建产物和运行期锁定边界，描述同一类问题的完整经验集合。一个 Cluster 对应一个 Package。
- **Module**：Package 内可独立选择的一条经验或约束，是强度标注、合并、反馈和运行时选择的最小单位。
- **SOP**：某次事件下，从已锁定 Package 中选出的一个或多个 Module 的注入表示。即使只选中一个 Module，也包装成单 Module SOP。

Package 是存储和锁定单位；Module 是选择单位；SOP 是实际提供给 Agent 的内容。三者不能混用。

### 2.2 六种 Module 类型

类型用于表达经验在执行链路中的功能，不直接决定强度：

| 类型 | 含义 | 典型来源 |
| --- | --- | --- |
| `tactic` | 通用操作策略 | 成功轨迹中的稳定做法 |
| `fast_path` | 更短、更直接的成功路径 | 高质量成功轨迹 |
| `avoidance` | 应避免的动作或路径 | 失败轨迹、无增益循环 |
| `verification` | 检查结果是否正确的方法 | 成败对照、验证器反馈 |
| `repair` | 已出现错误后的恢复步骤 | 失败后成功修复片段 |
| `invariant` | 全程必须持续满足的约束 | 明确权威要求 |

同一类型可以具有不同强度；同一强度也可以覆盖多个类型。类型负责说明“这条经验做什么”，强度负责说明“Agent 有多大裁量权”。

### 2.3 四级强度

| 强度 | 语义 | 运行要求 |
| --- | --- | --- |
| L1 | 参考信息 | Agent 可见，但不要求采用 |
| L2 | 建议或警告 | 明确建议采用，Agent仍可根据上下文放弃 |
| L3 | 强制指南 | 明确要求执行，并把完成条件、所需证据和失败恢复写进指南；系统只记录是否注入，不验证是否完成 |
| L4 | 权威硬约束 | 以最高强度明确告知 Agent；提交前若尚未注入可中断一次并补充注入，注入后不做合规验证 |

Module 一旦构建完成，其强度固定。SOP 的展示强度等于所含 Module 的最高强度，但这只是 SOP 的总体标签，不会提高其他 Module 的权限。

### 2.4 批量投票式强度划分

强度编译前先执行任务相关性门槛：只有直接影响当前任务如何执行、验证、修复或提交的内容才允许形成 Module Material 或直接分支的 Candidate Module。无关的系统模板、身份描述、通用能力说明和样板文本直接丢弃，不进入 L1--L4。

通过相关性门槛后，强度不按 Span 出现次数、成功率或证据数量划分。证据只负责证明 Material 是否可信、是否应保留；模型依据 Module 本身的约束方式和指南具体程度进行分级。

三次评审统一使用四项离散判断标准：

- **约束方式 `constraintMode`**：参考、建议、必须执行、权威硬约束。
- **指南具体度 `guideSpecificity`**：只给方向、给出明确动作、给出完整执行契约。
- **约束权威性 `authority`**：记录内容是普通经验、明确任务要求还是不可违反的任务硬约束。
- **可观察性 `observability`**：运行时能否从消息、工具调用、工具结果或产物中客观判断完成或违反。

Module 类型和证据出现次数都不参与等级判断。`evidencePattern` 仍可保留用于判断材料可信度，但不能把 Module 从 L1/L2 推高到 L3/L4。

使用以下固定判定标准：

| 等级 | 约束与指南标准 | 模型判级时应看到的内容 |
| --- | --- | --- |
| L1 | 只提供任务相关的方向、注意点或背景判断；Agent 仍需自行推导具体做法 | `instruction`、`scope` |
| L2 | 给出明确可执行的建议或规避动作，通常包含“何时、对什么、做什么”，但允许 Agent 不采用 | `instruction`、`scope`、`triggerEvents` |
| L3 | 明确要求执行，并把指南写成可检查的执行契约：触发条件、动作、完成条件、所需证据和失败恢复齐全 | L2 字段 + `completionRule`、`requiredEvidence`、`recovery`，且运行时可观察 |
| L4 | Span 或完整 Episode 轨迹中明确记录的任务硬约束；除具体动作外，还定义违反判定以及阻止提交后的恢复/停止方式 | L3 执行契约 + 记忆基座内可回查的硬约束记录 |

第三列是三次模型评审的判级依据，不是代码在投票后执行的二次强度校验。Module 抽取时尽量从证据中补齐执行契约；评审模型根据实际已有内容判断是否足以评为 L3/L4，聚合后代码不再降级或改分。

因此，重复出现只能提高“是否相信这条 Module”的把握，不能提高干预强度。相反，一条 Span 中若完整记录了任务相关的系统硬约束，也可以直接形成 L4。

强度划分必须以一个 Package 的一批 Candidate Module 为输入，不能逐个 Module 调用模型：

1. 为每条 Candidate Module 分配稳定 `moduleId`。
2. 构造包含当前 Package 全部 Candidate Module、证据摘要、权威来源和执行契约的单个评分批次；首版不再拆成多个小批。
3. 并发发起三次独立模型调用；三次使用完全相同的模型、评分 Prompt、温度和推理配置，唯一差异是按 `packageId + voteIndex` 生成可复现的随机种子，分别打乱 Module 顺序。
4. 每次调用返回所有 `moduleId` 的强度和简短理由，代码按 ID 对齐，不能依赖数组位置。
5. 某 Module 若至少两票相同，采用多数票；若三票分别为三个不同等级，则按 `L1=1 ... L4=4` 取中间等级。

```ts
interface StrengthVote {
  moduleId: string;
  constraintMode: "reference" | "advisory" | "required" | "hard_constraint";
  guideSpecificity: "directional" | "actionable" | "execution_contract";
  authority: AuthoritySource;
  observability: Observability;
  strength: "L1" | "L2" | "L3" | "L4";
  reason: string;
}

interface StrengthDecision {
  moduleId: string;
  votes: [StrengthVote, StrengthVote, StrengthVote];
  finalStrength: "L1" | "L2" | "L3" | "L4";
  aggregation: "majority" | "median";
}
```

三次结果应随最终 Module 一起保存，便于检查模型是否稳定。固定评分标准负责约束语义；代码只负责批量调用、可复现的顺序扰动、响应 Schema、ID 完整性、等级枚举和投票聚合，不根据 Module 字段再次过滤、降级或改分。聚合结果就是最终强度。

## 3. 构建链路

### 3.1 输入与触发

训练期只负责记录 Episode、任务得分和验证结果。Episode 落库时不得自动触发 `skill_cluster_assign`、Cluster 更新或 Package 构建。

训练全部结束后，由操作者执行一个显式命令；该命令在同一次离线流程中严格串行完成：

```text
训练完成
  -> 显式构建命令
  -> 读取本次训练产生的 Episode
  -> 对需要切分的复杂 Turn 构建 Span/Subgoal（包括正例和负例）
  -> 完整执行聚类
  -> 等待聚类完成
  -> 按 Cluster 构建 Module：复杂 Turn 走 Span -> Material -> Module；短或单目标 Turn 直接 -> Module
  -> 批量投票确定 Module 强度并合并同类项
  -> 构建并冻结 Package
  -> 输出构建统计和失败清单
```

增加顶层命令：

```bash
npm run direct-skill:build -- --episode-manifest <episode-ids.json> --builder package_v1
```

其中 `episode-ids.json` 由训练/评测 Harness 在本次训练结束时输出，内容是本批次的 Episode ID 列表。这一显式清单是构建输入的唯一边界，避免依赖当前 Episode 模型中不存在的 `trainingRunId`，也不借用语义不稳定的 `pipelineRunId`。命令必须先校验清单中的 Episode 全部存在且无重复，再调用独立的 Cluster Build Service 和 Package Build Service；不通过“每条轨迹触发一个异步 Job”的方式间接完成。某个 Cluster 的 Package 构建失败时应记录失败并使命令返回非零状态，不能把部分完成误报为成功。

旧版 Direct trace2skill 保留为实验基线和回滚能力，但同样改为显式调用：

```bash
npm run direct-skill:build -- --episode-manifest <episode-ids.json> --builder legacy
```

`legacy` 复用旧版“Cluster -> 单体 Skill”构建器，`package_v1` 使用新的分强度 Package 构建器。两种模式共享同一次离线聚类输入，均不得恢复 Episode 落库后的自动触发。

该决策使聚类和 Package 构建成为训练后的离线步骤：同一批轨迹先形成稳定 Cluster，再形成稳定 Package，结果不依赖 Episode 到达顺序，也符合当前“不做增量更新”的边界。

### 3.2 按 Turn 复杂度选择构建原料

不能把一个 Cluster 的完整轨迹拼接后一次生成 Module。读取 Cluster 下的训练 Episode 后，以 Turn 为边界选择两条构建分支：

- **复杂且包含多个子目标的 Turn**：复用 Span Pipeline 切分出多个 Span/Subgoal，再按 `Span -> Module Material -> Candidate Module` 构建。
- **较短或只有一个连贯子目标的 Turn**：不创建 Span，也不人为生成 `root_span`，直接以该 Turn 的任务、工具调用、结果和验证反馈构建一个 Candidate Module。

分支判定不另建连续评分器。工具调用少于现有 `span_big_turn` 门槛（11 次）时直接走 Turn 分支；达到门槛时，在一次 Span/Subgoal 分析中返回 `single_goal` 或 `multi_goal`。`single_goal` 不落 Span，`multi_goal` 必须返回至少两个连续 Span 并走 Span 分支。这样“是否切 Span”和“如何切”在同一次模型调用中完成。

复杂 Turn 分支沿 Episode 找到 Trace 及其 `span_ids`，使用 Span 的 `span_goal`、`summary`、`tool_call_start`、`tool_call_end` 回取连续工具调用。直接 Turn 分支使用 `rawTurnId` 定位完整但单一目标的执行记录。两条分支都不得读取其他 Cluster 的轨迹，也不得把整个 Cluster 一次交给模型。

Candidate Module 的 `evidenceRefs` 可以引用 Material/Span ID，也可以引用直接构建分支的 Raw Turn ID 和关键工具调用。直接分支严格保持 `1 Turn -> 1 Candidate Module`。所有 Candidate Module 汇合后，再以 Package 全量批次进行三次强度投票、去重、合并和冲突处理。

Package v1 允许从只有失败轨迹的 Cluster 构建 Package。此类 Package 只能包含失败 Span 或失败 Turn 实际支持的 `avoidance`、`repair`、`verification` 等 Module，不能因为缺少成功样本而让模型补造 `tactic` 或 `fast_path`。Legacy Direct 的原有 `skip_no_success_anchor` 行为保留为基线，不影响 Package v1。

现有 `span_big_turn` 只为正向奖励、工具调用数不少于 11 的长 Turn 创建 2--6 个子 Span。新的离线构建命令复用这套 Span/Subgoal 提取能力，但覆盖本次训练中需要切分的正例和负例，不再依赖奖励回传时的自动触发。无需切分的 Turn 直接进入 Module Extractor。

### 3.3 从 Span 提取 Module Material

大模型的第一层输入边界是 Span，而不是 Trace 或 Cluster。每个 Span 只发起一次结构化模型调用：先在响应中给出任务相关性结论，通过时同时返回 Module Material 和从该 Material 得到的 Candidate Module，不通过第二次 LLM 调用重复理解同一 Span。Material 是构建 Module 的内存中间结果，不单独持久化、不直接注入 Agent，也不携带最终强度。

```ts
type SpanModuleExtractionResult =
  | { decision: "reject"; reason: string }
  | {
      decision: "accept";
      material: ModuleMaterial;
      candidateModule: CandidateModule;
    };
```

```ts
interface ModuleMaterial {
  materialId: string;
  spanId: string;
  episodeId: string;
  subgoal: string;
  outcome: "success" | "failure" | "mixed";
  observation: string;
  proposedAction: string;
  scopeClues: string[];
  evidenceRefs: string[];
  authorityEvidence?: {
    statement: string;
    evidenceRef: string;
  };
}
```

- `observation` 描述 Span 中可被证据支撑的现象，例如失败原因、有效步骤或验证结果。
- `proposedAction` 是从该现象中提取的候选做法或规避动作，还不是最终 Agent 指令。
- `evidenceRefs` 指向 Span 及其中的关键工具调用/验证结果，不能只引用整个 Cluster。
- `authorityEvidence` 只记录记忆基座 Span 或完整 Episode 轨迹中真实出现的任务硬约束，并保留可回查引用；模型自己的补充不能成为约束来源。
- 相关性门槛在生成 Material 前作出 `accept/reject` 判断；被拒绝的 Span 不进入后续链路，不能靠降低强度继续保留。

离线上下文构建只读取记忆基座中的 Span 和完整 Episode/Turn 轨迹，不读取 System Prompt，也不从外部训练日志补充约束。某项硬约束若没有出现在这两类允许输入中，就不参与 Module 构建和强度评审。

复杂 Turn 分支对通过相关性门槛的 Span 严格保持 `1 accepted Span -> 1 Module Material -> 1 Candidate Module`。即使 Span 内包含多个动作，也由一个 Module 概括该子目标的完整指南，不再拆成多条 Material。首版不在 Material 层引入强度或运行时触发逻辑。

### 3.4 在同一结构化响应中形成 Candidate Module

提取 Prompt 要求模型先根据 Span 填写 Material 的观察、动作和证据，再在同一响应的 `candidateModule` 中形成 Agent 可理解的指令、类型、适用范围、运行事件和执行契约。代码校验 Candidate 的证据引用必须来自同一响应的 Material/Span，但不再调用一次模型：

```ts
interface CandidateModule {
  semanticKey: string;
  // Package 内的语义标识，只用于判断草稿是否表达同一经验。

  type: ModuleType;
  // 该经验在执行链路中的功能类型。

  instruction: string;
  // 告诉 Agent 应做什么或避免什么。

  scope: ModuleScope;
  // 经验适用的任务、工具、资源或操作范围。

  triggerEvents: RetrievalEventType[];
  // 允许在哪些运行事件中被选择。

  completionRule?: CompletionRule;
  // 指南中告诉 Agent 如何判断要求已完成；运行时不自动求值。

  requiredEvidence: EvidenceRequirement[];
  // 指南要求 Agent关注的完成证据；运行时不自动检查。

  recovery?: string;
  // 要求未满足或操作失败时应如何恢复。

  evidenceRefs: string[];
  // 支撑该草稿的 Material/Span ID，或直接构建分支的 Raw Turn/工具调用 ID；不得笼统引用整个 Cluster。

  authority: AuthoritySource;
  evidencePattern: EvidencePattern;
  // authority 和 evidencePattern 来自证据整理；四项分级判断由 StrengthVote 返回。
}
```

`semanticKey` 不是新业务层级，也不跨 Package 比较。它应是稳定、简短的规范化语义，如 `verify_formula_after_write`，不能使用完整自然语言句子或随机 ID。

Authority Resolver 不做另一次 LLM 调用，而是 `module-extractor.ts` 内的证据对齐步骤：它检查 `authorityEvidence.statement` 确实存在于所引 Span/Raw Turn，并把来源规范化为 `AuthoritySource`。找不到原文支撑时，候选抽取失败；对齐成功时，该结果交给三路强度评审判断，代码本身不据此直接指定 L4。

### 3.5 校验、批量强度投票和合并

构建代码按固定顺序处理候选草稿：

1. **Schema 校验**：字段、枚举和引用是否合法。
2. **证据回查**：`evidenceRefs` 是否真实存在，候选描述是否能在片段中找到支撑。
3. **批量强度评审**：同一批 Candidate Module 并发调用模型三次，每次打乱顺序，按 `moduleId` 汇总多数票或中位等级。
4. **投票落级**：多数票或中位数结果直接成为最终强度；代码不按执行契约、权威证据或可观察性进行二次过滤。
5. **Package 级整理**：一次模型调用读取当前 Package 全部已定级 Candidate，同时输出 `mergeGroups` 和 `alternativeGroups`。`mergeGroups` 只能包含 `semanticKey + type + strength` 相同且 `scope`/执行契约兼容的候选；`alternativeGroups` 包含解决相似问题但不可同时采用的方案。
6. **合并与互斥落库**：代码先校验每个 Candidate 最多属于一个 merge group，再生成合并后 Module。`alternativeGroups` 引用的是“merge group 或未合并的单个 Candidate”这两类整理单元，不直接引用将被合并掉的成员；代码为最终互斥 Module 填写 `alternativeGroupKey`。不根据权威性自动覆盖或删除 Module。

“兼容”表示两个草稿适用于同类任务/工具/资源，并且它们的触发条件、完成判定、所需证据和恢复动作可以由同一条 Module 准确表达；若合并会使适用范围变得含糊或执行条件互相矛盾，则保持独立。

语义相似不等于合并。单个 Span/Turn 的 Module 抽取器无法看到 Package 内其他候选，因此不由它生成 `alternativeGroupKey`。若两个 Module 解决同一问题但给出不同、不可同时执行的方案，Package 级整理会将它们保留为两个 Module，并赋予相同 `alternativeGroupKey`。该字段只表达 SOP 组合互斥，不建立执行层级，也不改变各自强度。

合并发生在强度投票之后。被合并的候选必须已经具有相同最终强度；最终 Module 保留每个来源候选的 `StrengthDecision`、`evidenceRefs` 和原始 `moduleId`，不把多个候选的投票压缩成一份无法追溯的记录。

当前阶段不根据相似度构建 Module 层级或执行顺序。Package 保存扁平 Module 集合，重点保证每条 Module 的证据、类型、强度和执行契约准确。

### 3.6 Package 产物

沿用现有 Skill Memory 作为外层持久化载体，在 `internal_info` 中存储专用结构，并增加明确标记：

```ts
interface DirectSkillPackage {
  schemaVersion: 1;
  packageId: string;
  clusterId: string;
  title: string;
  summary: string;
  status: "frozen";
  modules: DirectSkillModule[];
  sourceEpisodeIds: string[];
  createdAt: string;
}

interface DirectSkillModule extends CandidateModule {
  moduleId: string;
  strength: SkillStrength;
  alternativeGroupKey?: string;
  sourceModuleIds: string[];
  strengthDecisions: StrengthDecision[];
}
```

外层建议保留：

```ts
internal_info.runtime_managed = "direct_skill_v1";
internal_info.direct_skill_package = package;
```

新 Package 必须从通用 Skill Retrieval 和普通 Memory Packet 中排除，避免同一内容先被通用记忆注入、再被专用运行时重复注入。专用 Package Router 只复用现有向量、全文索引和存储能力，不进入通用候选混排逻辑。

存储共享不代表检索共享。所有 Package 同时写入 `direct-skill-package` 标签和 `runtime_managed = "direct_skill_v1"` 判别字段：

- 通用 Memory/Skill 检索在生成 top-k 候选前排除 `direct-skill-package` 标签；
- 专用 Router 用该标签召回，再检查 `runtime_managed` 作为结构安全门；
- 按 `packageId` 读取时同样校验 `runtime_managed`，不能把普通 Skill 当作 Package 解析；
- Package Router 可复用既有向量、全文索引和过滤能力，但拥有独立查询入口、候选集合与排序结果。

因此不新增专用数据库表，也不复制 Embedding/索引基础设施；隔离点位于 Repository 查询和运行时注入边界。

## 4. 检索、组合与注入链路

### 4.1 任务开始：选择并锁定 Package

运行时状态直接以 `AgentRunSpec.turnId` 作为 `taskKey`。状态在该次 Runner 任务的 `beforeRun` 创建，在 `afterRun` 清理。首版不为 Goal continuation 维护跨 turn 状态；当 `internalTurnContext.kind === "goal_continuation"` 时，Direct Skill Hook 直接不启用。

在任务的首次 `beforeRun` 中，以用户任务、工具集合、项目/资源信息构造查询：

1. Package Router 检索候选 Package；
2. 选择唯一 Package；
3. 将 `packageId` 写入本次任务的 Direct Skill Runtime State；
4. 整个任务只从该 Package 取 Module，不再跨 Package 检索。

Package Router 先使用专用索引召回候选，再由大模型根据当前任务选择一个 Package 或返回“不使用 Package”。首版不增加数值相关性阈值；模型选择为空时，本次任务不启用 Direct Skill。Package 一经选择立即锁定，后续不跨 Package。

锁定 Package 后，TurnStart 不按强度做代码侧硬过滤。模型从通过事件和 scope 边界过滤的候选中选择最小干预集合：普通情况下优先低干预的 L1/L2；与当前任务直接相关的 L4 可以从任务开始进入 SOP；尚未发生对应错误的 repair 等事件型 Module 不应提前选择。强度影响最终表达与一次性提交前干预，不决定 TurnStart 准入资格。

### 4.2 运行事件

首版支持四类事件：

```ts
type RetrievalEventType =
  | "turn_start"
  | "tool_error"
  | "no_progress"
  | "before_submit";
```

- `turn_start`：任务第一次开始，提供低干预经验及适用的前置约束。
- `tool_error`：工具调用返回错误，为模型提供相关 repair、avoidance、verification 候选。
- `no_progress`：连续三次调用相同工具，规范化后的关键参数相同，并且返回相同错误或没有产生新的状态/产物时触发；为模型提供相关 avoidance、fast_path、repair 候选。同一重复片段只触发一次。
- `before_submit`：Agent 准备给出最终答复时，检查是否仍有需要在提交前注入、但尚未注入的 Module。

事件来自运行时 Hook，而非在构建时从轨迹“预测”。构建阶段只为每条 Module 声明允许响应哪些事件；运行时实际发生事件后，才在允许集合中筛选。

同一工具批可能同时产生多个事件，例如第三次重复工具调用既是 `tool_error` 又满足 `no_progress`。事件检测器把本批工具结果产生的事件合并为一个 `RuntimeEventBatch`；后续对各事件候选取并集，但只执行一次模型选择、一次互斥校验和一次 SOP 注入。`before_submit` 是独立的单事件批。

```ts
interface RuntimeEventBatch {
  eventTypes: RetrievalEventType[];
  // 同一工具批或提交尝试实际发生的事件集合。

  fingerprint: string;
  // 用于识别“同一条件下的同一次干预”。

  context: RuntimeEventContext;
  // 本次工具结果、错误或提交尝试所需的最小运行时上下文。
}
```

### 4.3 Module 选择

选定 Package 后，代码先做边界过滤：

1. `RuntimeEventBatch.eventTypes` 与 `triggerEvents` 至少有一项交集；
2. `scope` 与当前任务、工具和资源相符；
3. 当前轨迹满足 Module 的触发条件；
4. `moduleId + eventFingerprint` 尚未注入。`eventFingerprint` 由排序后的事件类型集合、工具名、规范化关键参数和错误/状态摘要生成，用于防止无变化的重复注入。`before_submit` 只在任务级 `beforeSubmitIntervened = false` 时进入候选选择，并额外排除本任务中任意时刻已注入过的 `moduleId`。

这里不根据 `completionRule` 判断 Module 是否“已完成”，因为首版明确不做运行时完成验证。若过滤后候选为空，直接结束本次事件处理，不调用模型。非空候选连同当前任务、合并后的事件和近期轨迹交给大模型选择。这里不实现“强度优先”“证据分数优先”等代码侧策略排序；选择理由由模型根据当前上下文判断。

选择 Prompt 的固定约束为：

```text
只从候选 Module ID 中选择，不改写 Module。
选择当前事件真正需要的最小集合。
同一 alternativeGroupKey 最多选择一个方案。
不要组合互不兼容的方案。
返回 selectedModuleIds 和简短选择理由。
```

Memory 端代码只校验返回 ID 属于当前锁定 Package、属于已过滤候选集，并保证同一互斥组最多一个；校验失败时要求模型重新选择，不由代码替换成另一个 Module。互斥性只在 `DirectSkillRetrievalService.selectModules()` 的 `validateSelectedModules()` 中校验一次；SOP Composer 不再维护第二套规则。App 仅用已发送的候选 Map 解析返回 ID，出现未知 ID 时放弃本次注入。

### 4.4 SOP 组合

SOP Composer 把选中的 Module 转成一段 Agent 易读的运行指令：

```ts
interface RuntimeSop {
  events: RetrievalEventType[];
  packageId: string;
  strength: SkillStrength; // 所含 Module 的最高强度
  modules: RuntimeSopModule[];
}
```

组合只做表达层工作：保持 Module 原文，按“当前问题 -> 要做什么 -> 如何验证 -> 失败后如何恢复”组织并标明每条要求的强度。它不再改写或语义去重 Module，也不重复实现互斥校验；内容合并在构建阶段完成，运行时选择后由共享校验器保证合法。SOP Composer 不能修改 Module 强度、扩大适用范围或创造新要求。

### 4.5 注入行为

- L1：未被选择时不注入；一旦被模型选入 SOP，就直接展示完整但精简的指南，并明确标记为非强制参考，不只显示标题，也不要求 Agent 再次展开。
- L2：作为当前事件下的明确建议或警告。
- L3：展示要求、完成条件、所需证据和恢复动作；系统不检查 Agent 是否完成。
- L4：展示权威硬约束；若直到提交前仍未注入，可中断一次提交并补充注入，之后不检查执行结果。

运行时不直接注入“裸数据对象”。单个或多个 Module 都由 SOP Renderer 包装为一致的 Prompt 结构，以便 Agent 理解来源、当前事件、动作要求和证据要求。

### 4.6 提交前一次性干预

核心原则：**系统只保证相关 Module 有机会在提交前被注入，不验证 Agent 是否遵循，也不检查完成证据。**

`before_submit` 是 Agent 提交最终答案前的最后一次检索事件，对应 Runner 新增的 `beforeFinalResponse()` Hook。当模型返回不包含工具调用、Runner 原本准备把它作为最终答案交给用户时触发。普通中间消息、携带工具调用的响应、工具报错，以及最大循环次数或运行时异常造成的强制结束不触发该事件。

处理流程：

1. `beforeFinalResponse` 先读取任务级 `beforeSubmitIntervened`；若已为 `true`，不再检索 Module，直接放行本次最终答复；
2. 若仍为 `false`，读取当前锁定 Package、完整任务轨迹和本任务已经注入过的 Module ID；
3. 大模型从 `before_submit` 合法候选中选择仍有必要提醒、且尚未注入的 Module；
4. 若没有选中 Module，正常提交最终答案；
5. 若选中 Module，将“SOP 成功入队”与 `beforeSubmitIntervened: false -> true` 作为同一次原子状态转换；只有转换成功才取消本次提交并让 Agent 继续运行；
6. Module ID 写入已注入集合；后续不验证是否执行，也不会再因其他 `before_submit` Module 中断提交。

`completionRule`、`requiredEvidence` 和 `recovery` 仍可作为 Module 指南的一部分展示给 Agent，但系统不对它们求值。首版不实现证据 DSL、完成状态判断或 LLM 合规检查。

### 4.7 单一注入通道

Direct Skill Hook 只负责生成 SOP Prompt 并放入待注入队列，不直接向 `messages` 写入内容。Runner 复用现有 `injectionCallback`/drain 机制，在工具结果、继续循环和提交前检查点从同一组合队列中取出外部 pending injection 与 Direct Skill SOP。一条 SOP 只入队一次、只由 Runner drain 一次，不新建 Direct Skill 专用的第二套 `messages.push` 或 drain 路径。

同一 `RuntimeEventBatch` 最多产生一条 SOP。Direct Skill 注入仍受 Runner 现有注入次数和循环上限保护，不另建无上限的继续机制；强制结束场景本来就不触发 `before_submit`。

### 4.8 Module 级干预记录

为了支持测试指标，Runtime 在现有任务轨迹/运行日志中追加结构化干预条目，不新建一份重复的任务记录：

```ts
interface DirectSkillInterventionLog {
  taskKey: string;
  packageId: string;
  eventTypes: RetrievalEventType[];
  moduleIds: string[];
  injectedAt: string;
}
```

评测时按 `taskKey` 与现有任务结果、工具调用、Token 和延迟记录关联，不在 Direct Skill 内再存一份 outcome。该条目只用于定位注入和计算 Module 级干预收益，不反向修改 Module、强度或 Package，也不启动本阶段已排除的迭代更新链路。

## 5. 代码级改动计划

### 5.1 代码边界与最小目录

新链路只分两个边界：`Memory` 负责离线构建、Package 检索和模型选择；`App/memmy-agent` 负责观察运行事件、锁定 Package、组合 SOP 与入队。不调用 L2/L3、Policy、World Model 或 Skill Trial 服务。为避免过度拆分，首版只新增以下文件：

```text
Memory/src/algorithm/direct-skill/
  types.ts                 # Package、Module、Material、强度投票的共享类型
  module-extractor.ts      # Span/Turn 上下文构造、Schema 校验和单次抽取
  strength-voter.ts        # 三路并发批量评审、乱序和多数票/中位数聚合
  package-builder.ts       # 候选汇总、一次合并/互斥整理、最终 Package 生成

Memory/src/service/direct-skill/
  direct-skill-build-service.ts      # manifest -> Span/Turn -> Cluster -> legacy/Package
  direct-skill-retrieval-service.ts  # Package Router 与运行时 Module 选择

App/memmy-agent/src/direct-skill-runtime/
  types.ts                 # Runtime State、EventBatch、SOP 和干预日志
  event-detector.ts        # tool_error/no_progress 检测与同批合并
  hook.ts                  # Package 锁定、候选过滤、SOP 渲染、入队和状态清理
```

`Memory/src/algorithm/trace-direct-skill.ts` 和现有 legacy 测试保留；不将 Package v1 继续塞进该文件。选择校验、SOP Composer 和 Renderer 首版作为 `hook.ts` 内的小函数，不各自建类。

### 5.2 显式命令、配置和 API

1. 在 `Memory/src/config/index.ts` 的 `AlgorithmConfig.skill` 增加：

   ```ts
   directMode: "off" | "legacy" | "package_v1";
   ```

   旧 `directFromTrace` 仅作配置兼容输入：当 `directMode` 缺失时，`true -> legacy`、`false -> off`。它不再表示“Episode 入库后自动调度”。`App/memmy-agent/src/memmy-memory/config.ts` 从同一个 `memmyMemory.algorithm.skill.directMode` 解析运行模式，不再增加第二份顶层配置。

2. 在根 `package.json` 增加：

   ```json
   "direct-skill:build": "tsx Memory/src/cli/index.ts direct-skill build"
   ```

   `Memory/src/cli/commands.ts::mapTopLevelCommand()` 增加 `direct-skill build`，只接受 `--episode-manifest` 和 `--builder legacy|package_v1`。CLI 读取 JSON 后校验其为非空、无重复的 Episode ID 数组，再请求运行中的 Memory 服务。返回中含任一 `failures` 时 CLI 抛错，使命令退出码为 1。

3. `Memory/src/server/http.ts` 和 `Memory/src/service/memory-service.ts` 增加三个窄接口：

   ```ts
   POST /api/v1/direct-skills/build          // admin write，整批离线构建
   POST /api/v1/direct-skills/route-package  // memory read，任务开始选唯一 Package
   POST /api/v1/direct-skills/select-modules // memory read，从合法候选 ID 中选 Module
   ```

   不增加 Package 更新、融合、版本迁移或反馈 API。

   运行时两个接口使用明确的最小 DTO：

   ```ts
   interface RouteDirectSkillPackageRequest extends RequestEnvelope {
     query: string;
     toolNames: string[];
     workspace?: string;
   }
   interface RouteDirectSkillPackageResponse {
     package: DirectSkillPackage | null;
   }

   interface SelectDirectSkillModulesRequest extends RequestEnvelope {
     packageId: string;
     candidateModuleIds: string[];
     event: RuntimeEventBatch;
     taskMessages: Record<string, unknown>[];
     draftFinalAnswer?: string;
   }
   interface SelectDirectSkillModulesResponse {
     packageId: string;
     selectedModuleIds: string[];
     reason: string;
   }
   ```

   `taskMessages` 传当前 `AgentRun` 的全部可观测轨迹；`before_submit` 额外传当前候选答复。不传 System Prompt，不传其他任务或其他 Package 数据。

### 5.3 Memory 离线构建实现

`DirectSkillBuildService` 只暴露一个编排入口：

```ts
interface DirectSkillBuildRequest {
  episodeIds: string[];
  builder: "legacy" | "package_v1";
}

interface DirectSkillBuildResult {
  episodeCount: number;
  clusterIds: string[];
  builtMemoryIds: string[];
  failures: Array<{ clusterId?: string; episodeId?: string; reason: string }>;
}

build(request: DirectSkillBuildRequest): Promise<DirectSkillBuildResult>;
```

内部按以下顺序执行，不创建 `skill_cluster_assign` / `skill_batch_evolve` 中间 Job：

1. 通过 `repos.runtime` 一次校验 manifest 内 Episode 全部存在，并加载对应 Raw Turn。
2. `Memory/src/service/evolution/big-turn-span-pipeline.ts` 新增 `segmentForDirectSkill(rawTurnId)`：工具调用少于 11 次直接返回 `single_goal`；达到门槛时复用现有 Prompt 和 Span 落库代码，一次 LLM 返回 `single_goal` 或至少两个连续 Span 的 `multi_goal`。该入口同时处理成功和失败 Turn，不检查正奖励。
3. 从 `Memory/src/service/evolution/skill-cluster-pipeline.ts::assignCluster()` 抽出不依赖 `EvolutionJobRecord` 的 `assignEpisodeForDirectBuild(episodeId, at)`；保留原聚类特征和阈值，但返回 `clusterId` 而不 enqueue evolve Job。
4. `Memory/src/service/evolution/reward-pipeline.ts` 删除 Episode 完成后自动 enqueue `skill_cluster_assign` 的分支。打分、Episode 和其他记忆演化不变。
5. `legacy` 对每个 Cluster 调用从现有 `evolveCluster()` 抽出的共享构建核心；`package_v1` 进入新 `PackageBuilder`。两者复用同一次聚类结果。
6. `ModuleExtractor` 提供 `extractFromSpan()` 和 `extractFromTurn()`。前者一次结构化调用返回 reject 或 `Material + CandidateModule`；后者一次调用返回 reject 或单个 Candidate。证据引用必须落在当前 Span/Raw Turn 内。
7. `StrengthVoter.grade(packageId, candidates)` 用 `Promise.all()` 并发三路整批评审；输入顺序由 `stableHash(packageId + voteIndex)` 驱动的本地洗牌决定。每路必须返回且仅返回全部 `moduleId`，否则该 Package 构建失败。聚合仅实现多数票/中位数，不二次改分。
8. `PackageBuilder` 在强度固定后只再做一次 LLM 调用，同时返回 `mergeGroups` 和 `alternativeGroups`；代码校验组内 ID、合并条件和互斥引用，再生成冻结 Package。
9. Package 外层 `memoryValue` 渲染为简短的检索摘要（标题、问题类型、工具/资源范围和 Module 摘要），再复用现有 Embedding 能力建索引。全量 Module 结构仅放在 `internal_info.direct_skill_package`，不把整包 JSON 当检索文本。

Package 继续使用现有 `buildMemory()` 和 `repos.memories` 写为 `SkillMemory`，不新建表或 Repository：

```ts
memoryKey = `skill:direct-package:${clusterId}`;
tags = ["skill", "direct-skill-package"];
properties.internal_info.runtime_managed = "direct_skill_v1";
properties.internal_info.direct_skill_package = package;
```

`package.packageId` 与外层 `MemoryRow.id` 使用同一 ID。若该 `clusterId` 已存在冻结 Package，本阶段直接报错，不暗中更新或合并。

### 5.4 Memory 专用检索与选择

1. 在 `Memory/src/types.ts::MemoryFilter` 增加 `excludedTags?: string[]`，并在 `Memory/src/storage/repositories.ts::buildMemoryWhere()` 对 `tags_json` 生成 `NOT EXISTS` 条件。`Memory/src/service/retrieval/indexed-candidate-pool.ts` 的 count、vector/FTS/pattern 入口都透传该字段，使 Package 在 top-k 候选生成前就被排除，不做召回后过滤。
2. `RetrievalService.search()` 按 `directMode` 传入固定排除标签：`off` 排除 `direct-trace` 和 `direct-skill-package`；`legacy` 只排除 `direct-skill-package`；`package_v1` 排除 `direct-trace` 和 `direct-skill-package`。因此 Package 永远不会进入通用 Memory Packet，三组实验也不会串组。
3. `DirectSkillRetrievalService.routePackage()` 复用 `compileRetrievalQuery`、Embedding 和 `IndexedCandidatePool`，但固定 `layers: ["Skill"]` 且 `tags: ["direct-skill-package"]`。召回后再确认 `runtime_managed === "direct_skill_v1"`，然后用一次 LLM 在候选中返回一个 `packageId` 或 `null`。
4. `DirectSkillRetrievalService.selectModules()` 接收已锁定 `packageId`、候选 Module ID、`RuntimeEventBatch` 和任务轨迹；模型只能返回这批候选 ID。Memory 端用唯一的 `validateSelectedModules()` 校验 ID 与 `alternativeGroupKey`；App 只把返回 ID 映射回已发送候选，不重复实现互斥规则。候选为空时 App 不发请求。

### 5.5 App 运行时接入

`DirectSkillTaskState` 只保留首版真正使用的状态：

```ts
interface DirectSkillTaskState {
  taskKey: string;                       // AgentRunSpec.turnId
  package: DirectSkillPackage | null;    // beforeRun 选定后不再替换
  recentToolSignatures: string[];        // 最多三个，用于 no_progress
  emittedFingerprints: Set<string>;      // 防止同一事件重复注入
  injectedModuleIds: Set<string>;
  beforeSubmitIntervened: boolean;
}
```

`App/memmy-agent/src/memmy-memory/client.ts` 增加 `routeDirectSkillPackage()` 和 `selectDirectSkillModules()`。`App/memmy-agent/src/memmy-memory/register.ts` 在现有 `MemmyMemoryHook` 之后注册 `DirectSkillRuntimeHook`；它只复用 client、request envelope 和当前用户任务文本，不把逻辑写入 `MemmyMemoryHook.beforeRun()`。

Hook 生命周期如下：

- `beforeRun`：若是 `goal_continuation`或缺少 `turnId`，直接返回；否则以 `turnId` 创建状态，路由且锁定一个 Package，为 `turn_start` 过滤/选择 Module，生成一条 SOP 后调用 `spec.injectionEnqueueCallback()`。
- `afterToolBatch`：读取本批 `toolCalls/toolResults/toolEvents`，一次生成同一 `RuntimeEventBatch`。`toolEvents.status === "error"` 生成 `tool_error`；连续三个工具名、规范化关键参数和结果/状态摘要都相同时增加 `no_progress`。两者重合时只调用一次 Module 选择。
- `beforeFinalResponse`：只处理正常、非空、无工具调用的候选最终答复。首次选中 Module 并成功入队后置 `beforeSubmitIntervened=true`；之后直接放行。
- `afterRun`：删除 `turnId` 对应状态。不保留到下一 turn，不触发 Package 反馈或更新。

`App/memmy-agent/src/core/agent-runtime/hook.ts` 增加两个 `void` 生命周期，`CompositeHook` 按现有方式串行转发：

```ts
afterToolBatch(ctx: AgentHookContext): Promise<void>;
beforeFinalResponse(ctx: AgentHookContext): Promise<void>;
```

二者只负责入队，不返回新的控制枚举。Runner 仍以“队列是否真正 drain 出消息”决定是否继续，避免 Hook 返回 `continue` 但队列为空的双重状态。

`App/memmy-agent/src/core/agent-runtime/runner.ts` 做五个定点改动：

1. `AgentRunSpec` 增加 `injectionEnqueueCallback(payload): boolean`，Hook 只通过它入队；现有 `injectionCallback` 仍是唯一 drain 入口。
2. `hook.beforeRun()` 后、第一次模型请求前执行一次现有 `tryDrainInjections()`，使 TurnStart SOP 真正进入首轮 Prompt。
3. 一批工具结果写入 `context.toolResults/toolEvents` 后，在 fatal/normal drain 之前调用一次 `afterToolBatch`。同时补齐工具直接抛异常的 catch 分支也调用 `afterToolCall`，保证现有 Hook 合约一致。
4. 候选最终答复通过 error/blank/length 判定后，先调用 `beforeFinalResponse`，再只调用一次 `tryDrainInjections()`；若 drain 到 SOP，现有逻辑保留本次 assistant draft、追加 SOP 并进入下一轮。最大迭代强制收尾不调用该 Hook。
5. `AgentRunResult` 增加 `directSkillInterventions`。Runner 仅在 drain 到带 `direct_skill_intervention` 元数据的消息时追加日志，因此“已入队但未真正注入”不会计入指标。

`App/memmy-agent/src/core/agent-runtime/loop.ts` 为每次 `runAgentLoop()` 将 `injectionEnqueueCallback` 绑定到当前已有的 `pendingQueue`：Direct Skill SOP 被包装成内部 `InboundMessage` 并 `put()` 到这一队列，不创建 Direct Skill 私有队列。`pendingToUserMessage()` 保留 `direct_skill_intervention` 元数据，`runner.ts::buildRequestArgs()` 在发给 Provider 前删除该机器元数据，Agent 只看到 SOP 文本。

干预日志沿用现有 turn 落库：

- `MemmyMemoryHook.afterRun()` 将 `result.directSkillInterventions` 传入 `completeTurn()`；
- `Memory/src/types.ts::TurnCompleteRequest` 增加可选 `directSkillInterventions`；
- `Memory/src/server/http.ts` 将该字段加入 `publicRequest`；
- `Memory/src/service/turn/turn-normalization.ts` 清洗后保存到 `RawTurnRecord.messagePayload.turn_complete.direct_skill_interventions`。

这样 outcome、usage、工具轨迹和干预记录共享同一 Raw Turn，不新建结果表。

### 5.6 评测模式

生产代码只读 `directMode: off | legacy | package_v1`。SpreadsheetBench Harness 另外传入：

```ts
interventionMode: "static" | "dynamic" | "full";
```

`static` 只启用 `turn_start`；`dynamic` 再启用 `tool_error` 和 `no_progress`；`full` 再启用一次 `before_submit`。该参数仅用于实验消融，不扩展生产配置矩阵。

## 6. 测试计划

### 6.1 单元测试

测试文件与代码边界对齐：构建算法放在 `Memory/tests/algorithm/direct-skill/`，构建/检索服务放在 `Memory/tests/service/direct-skill/`，HTTP 放在 `Memory/tests/contract/direct-skill-http.test.ts`，CLI 扩展现有 `Memory/tests/cli-command-map.test.ts`，运行时放在 `App/memmy-agent/tests/direct-skill-runtime/`，Runner 生命周期回归扩展现有 `runner-hooks.test.ts`、`runner-injections.test.ts` 和 `runner-tool-execution.test.ts`。

新增与核心实现一一对应的测试：

- `build-input`：Episode manifest 严格限定本次构建输入；缺失或重复 ID 在聚类前直接失败。
- `explicit-build-command`：`legacy|package_v1` 都通过显式 API 执行；训练期 reward pipeline 不再产生 Cluster/Skill evolve Job；任一 Cluster 失败时 CLI 返回非零。
- `strength-voter`：每次调用都包含当前 Package 的全部 Candidate Module 和 L1--L4 判级内容，三次调用并发执行并按 `moduleId` 对齐；模型、Prompt 和生成参数完全相同，使用 `packageId + voteIndex` 的固定种子生成三种可复现排列。
- `strength-aggregator`：两票相同时采用多数票；三票各不相同时按 L1--L4 序值取中位等级。
- `span-context-builder`：只回取 Span 范围内的连续工具调用，并保留必要的任务与验证结果上下文。
- `turn-segmentation`：短 Turn 直接走 Turn 分支；达到工具调用门槛的 Turn 以一次调用返回 `single_goal` 或带至少两个连续 Span 的 `multi_goal`。
- `module-extractor`：每个 Span 只调用模型一次；可拒绝无关 Span，或一次返回一条 Material 及一个 Candidate；Candidate 只引用同一 Material/Span 的证据。短或单目标 Turn 一次返回一个 Candidate，并可回溯到 Raw Turn/工具调用。Authority Resolver 会拒绝无法在引用轨迹中对齐的权威声明。
- `package-builder`：failure-only Cluster 可以构建 Package，但不会生成缺乏成功 Span/Turn 支撑的 `tactic` 或 `fast_path`。
- `module-validator`：校验 Candidate Schema、证据引用和 scope，但不根据字段内容过滤、降级或修改聚合强度。
- `package-consolidator`：同一 Package 只执行一次模型整理，同时返回合并组和互斥组；互斥组只引用 merge group 或 singleton；只合并同语义、同类型、同强度且契约兼容的草稿，并保留全部来源 `moduleId`、证据和三路投票；互斥方案不合并。
- `direct-mode-filter`：`off|legacy|package_v1` 严格按标签排除对应 Direct Skill，Package 不会占用通用 top-k；专用 Router 只能返回 tag 和 `runtime_managed` 都匹配的 Package。
- `event-detector`：`no_progress` 在连续三次相同工具、相同规范化关键参数且结果相同错误或无新状态/产物时触发，同一重复片段只触发一次；同一工具批的 `tool_error + no_progress` 合并为一批。
- `module-selector`：候选为空时不调用模型；非空时模型只能返回合法候选 ID，并保证同一互斥备选组最多选择一个；代码不实施强度优先等替代选择策略。
- `beforeFinalResponse`：没有新的提交前 Module 时放行；首次选中时将 SOP 成功入队与 `beforeSubmitIntervened=true` 作为同一状态转换，然后取消本次提交；之后的提交直接放行，不再检索其他 Module。
- `task-state`：状态按 `AgentRunSpec.turnId` 隔离并在 `afterRun` 清理；`goal_continuation` 不创建状态、不调用 Package Router；`beforeSubmitIntervened` 从 `false` 只能转换为 `true` 一次。
- `injection-drain`：TurnStart SOP 在首次模型请求前 drain；工具批在 `afterToolBatch` 选择后只经现有 drain 路径注入；提交前 Hook 与 drain 之间没有第二套 `messages.push`。
- `runner-hook-order`：抛异常和返回 `Error...` 的工具都可被 Hook 观察；`afterToolBatch` 在 fatal/normal drain 前调用且每批一次；强制收尾不调用 `beforeFinalResponse`。
- `intervention-log`：每次注入在现有任务轨迹/日志中追加 Package、事件和 Module ID；可按 `taskKey` 与已有 outcome/用量记录关联，不重复存储 outcome，也不反向修改 Package。

保留并运行现有测试：

- `Memory/tests/algorithm/trace-direct-skill.test.ts`
- `Memory/tests/service/evolution/skill-cluster.test.ts`

legacy 的 Cluster 分配算法、Skill 生成和通用检索结果由原测试锁定；“Episode 落库后自动 enqueue”的旧断言需改为“仅显式构建命令触发”。Package v1 使用独立新测试。

### 6.2 集成测试

至少覆盖四条端到端链路：

1. Cluster 构建出冻结 Package，包含不同类型与强度 Module；
2. TurnStart 选中一个 Package，并在后续事件保持锁定；
3. 工具报错或无增益循环后追加 SOP，Agent 继续调用工具；
4. 提交前选中尚未注入的 Module 时只中断一次并追加 SOP；Agent 继续后的下一次提交直接放行，不做完成/证据检查，也不再选择其他提交前 Module。

同时验证新 Package 不会出现在通用 Memory Packet 中；同一工具批的 `tool_error + no_progress` 只会进行一次选择和注入；Goal continuation 不调用 Direct Skill Runtime。

### 6.3 SpreadsheetBench 评测

数据集路径：

```text
/root/gyh/Trace2Skill/data/spreadsheetbench_verified/spreadsheetbench_verified_400
```

不单设 dev 集。400 个任务按任务粒度和类型重新分层为 train/test，不能直接按当前文件顺序前后切分，因为当前顺序会造成 Sheet-Level 与 Cell-Level 分布严重偏斜。

评测组：

| 组别 | 含义 |
| --- | --- |
| Base | 不启用 Direct Skill |
| Legacy Direct | 当前一次生成整体 Skill 的实现 |
| Package Static | 只在 TurnStart 注入同一 Package 的初始 SOP |
| Package Dynamic | TurnStart + 工具错误/无增益 |
| Package Full | Dynamic + 提交前一次性 Module 干预 |

实用指标保持精简：

- 任务成功率：最终任务是否通过验证；
- 平均工具调用数或完成步数：是否减少无效操作；
- 干预收益：发生动态干预的任务中，干预后成功率及恢复率；
- 提交前干预收益：发生一次性提交前干预的任务比例，以及干预后的任务成功率；
- Token/延迟开销：Package 检索、SOP 注入和额外 turn 的成本。

不单独设计反事实测试；Golden 文件隔离暂不纳入本阶段。验证器已知问题应在正式实验前做最小修复或排除，并记录任务 ID，避免把验证器错误算作 Skill 效果。

## 7. 推荐开发顺序

### 阶段 A：锁定基线

1. 为 legacy Direct 构建和检索行为补充回归测试；
2. 增加 `off | legacy | package_v1` 分流；
3. 确认 `off` 只关闭 Direct Skill，不影响 L1/L2/L3 和其他普通 Skill 检索。

### 阶段 B：完成离线构建

1. 定义类型和 Schema；
2. 将现有 Span/Subgoal 提取接入显式离线命令：短 Turn 直接进入 Module 抽取，长 Turn 在一次调用中判定 `single_goal | multi_goal` 并仅为后者落 Span；
3. 实现两条 Candidate 构建路径：复杂 Turn 中每个 Span 以一次结构化调用返回 Material+Candidate，短或单目标 Turn 以一次调用直接返回 Candidate；
4. 实现批量三路强度评审和投票聚合，再通过一次 Package 级整理同时完成同类合并分组与互斥备选分组；
5. 实现显式命令及离线聚类入口，移除 `package_v1` 的 Episode 自动聚类触发；
6. 实现 Package 持久化，并在聚类完成后按 Cluster 构建；
7. 用少量真实训练批次检查两条输入路径、Module 强度和 Package 构建产物。

### 阶段 C：完成 TurnStart 闭环

1. 实现 Package Router；
2. 从通用 Skill Retrieval 排除 Package v1；
3. 实现以 `AgentRunSpec.turnId` 为键的任务级状态，Goal continuation 直接跳过；
4. 注册独立 Runtime Hook；
5. 完成 Package 锁定、Module 选择和单队列 SOP 注入。

### 阶段 D：增加事件驱动干预

1. 接入 tool error；
2. 接入 no-progress；
3. 将同一工具批的重叠事件合并为一个 `RuntimeEventBatch`；
4. 在现有任务轨迹/日志中追加每次事件批、选择结果和实际注入的 Module ID，通过 `taskKey` 关联既有最终结果。

### 阶段 E：增加提交前一次性干预

1. 增加 `beforeFinalResponse` Hook；
2. 复用 Module 选择器处理 `before_submit` 候选，并读取任务级已注入 Module ID 和 `beforeSubmitIntervened`；
3. 首次选中时原子完成 SOP 入队与 `beforeSubmitIntervened=true`，再取消本次提交并继续循环；
4. 验证之后的提交直接放行，不再运行 `before_submit` Module 选择。

### 阶段 F：实验与验收

1. 准备 SpreadsheetBench 分层 train/test 清单；
2. 构建训练 Cluster 的 Package；
3. 运行 Base、Legacy、Static、Dynamic、Full；
4. 汇总成功率、效率、动态干预收益、提交前一次性干预收益和成本。

每个阶段单独提交，保证可回滚；不在一个提交中同时重写构建、检索和 Runner 生命周期。

## 8. 完成标准

- 同一 Cluster 可稳定构建一个包含多个固定强度 Module 的冻结 Package；
- 强度由三次并发的批量模型评审产生，三批输入顺序不同，代码按 Module ID 执行多数票或中位等级聚合；
- Span 的 Material 与 Candidate 由一次结构化模型调用产生，不重复读取同一 Span；
- Package 级整理一次完成合并分组和互斥分组；
- 新 Package 与通用记忆注入隔离；
- 每个任务至多锁定一个 Package，运行期间不跨 Package；
- Goal continuation 不启用 Direct Skill Runtime，不产生 Package 锁定或 SOP；
- TurnStart、tool error、no-progress 和 before-submit 均可触发同 Package 内的 SOP；
- 同一工具批的重叠事件只做一次模型选择和一次 SOP 注入；
- 单 Module 可形成合法 SOP；
- 相似但互斥的 Module 可以共存于 Package，同一 SOP 不会同时包含它们；
- 一个任务的提交前干预最多发生一次；注入后不做完成验证，下一次提交直接放行；
- 每次 Module 注入都可与本任务的最终结果关联，但不触发 Package 或强度更新；
- 除触发改为显式命令外，legacy 的聚类、Skill 生成和检索语义未回归；
- SpreadsheetBench 五组实验可复现并输出精简指标。

## 9. Grill 决策记录

以下决策均已确认，实现时不得自行改回旧方案：

1. **已确认**：训练期只落轨迹；训练全部完成后执行一个显式命令，依次完成聚类和 Package 构建，不由轨迹落库事件触发。
2. **已确认**：保留 legacy Direct 作为实验基线和回滚能力，但也只允许显式构建，不保留 Episode 落库自动触发。
3. **已确认**：Package 使用现有 `SkillMemory` 外壳，主体保存在 `internal_info.direct_skill_package`，并用 `runtime_managed = "direct_skill_v1"` 标识。
4. **已确认**：通用 Skill Retrieval 和普通 Memory Packet 排除 Package，避免普通记忆链路重复注入。
5. **已确认**：提供只检索 Direct Skill Package 的专用入口；Router 可复用现有存储、Embedding、向量和全文索引，但不进入通用候选混排。
6. **已确认**：构建与 Package 检索能力位于 `Memory`；运行期事件检测、SOP 注入和提交前一次性干预首版只接入 `App/memmy-agent`，不改造其他 Agent Adapter。
7. **已确认**：复杂且包含多个子目标的 Turn 复用现有 Span/Subgoal Pipeline；先过滤与子目标和验收无关的 Span，再对通过者严格执行 `1 accepted Span -> 1 Module Material -> 1 Candidate Module`。较短或只有一个连贯子目标的 Turn 不创建 Span/root span，严格执行 `1 Turn -> 1 Candidate Module`。两条路径汇合后统一进行 Package 级批量强度投票。已撤销相似度分层和执行顺序组织。
8. **已确认**：Package v1 允许 failure-only Cluster 构建 Package，但只生成失败 Span 有证据支撑的规避、修复或验证 Module，不虚构成功策略或 fast path；Legacy 保留原跳过行为。
9. **已确认**：构建器不读取 System Prompt，也不从外部训练日志补充权威消息；唯一输入是记忆基座中的 Span，或无需切分时的完整 Episode/Turn 轨迹。强度评审只依据这些记录中实际可见、与任务相关的内容，L4 也必须能回查到其中的任务硬约束。
10. **已确认**：解决相似问题但方案不兼容的 Module 共存于同一 Package，并进入同一互斥备选组；检索阶段由大模型根据当前上下文选择，一次 SOP 最多一个。代码只验证选择结果，不实现组内策略排序。
11. **已确认**：强度不按 Span 次数或证据数量划分。每个 Package 的 Candidate Module 必须整批评审，不能逐条调用；同一批 Module 并发调用模型三次，每次打乱顺序，再按 `moduleId` 对齐。至少两票一致时取多数票；三票分别为不同等级时取三个等级的中位数。L1--L4 的约束与指南具体度标准作为三次调用共享的评分 rubric。
12. **已确认**：投票聚合结果就是最终强度。代码只校验评分响应的 Schema、Module ID 完整性和等级枚举，不根据执行契约、权威来源或可观察性过滤、降级、改分或重投。
13. **已确认**：三次批量评审使用同一模型、同一评分 Prompt、同一温度和推理配置，并真正并发执行；三次输入唯一差异是 Module 排列顺序。
14. **已确认**：一个评分批次包含当前 Package 的全部 Candidate Module，不按 Module 数量拆分小批；因此每个 Package 固定发起三次强度评分调用。
15. **已确认**：TurnStart 不按强度做代码侧硬过滤；大模型选择最小干预集合，普通情况下优先 L1/L2，任务直接相关的 L4 可以进入，未触发的事件型 Module 不提前选择。
16. **已确认**：L1 未被选择时不注入；一旦进入 SOP，就直接展示完整精简内容并标记为“参考、非强制”，不采用标题占位或按需展开。
17. **已确认**：保留提交前检查点；当模型返回无工具调用、Runner 原本准备提交最终答案时触发。普通中间消息、工具调用、工具报错和强制结束不触发。
18. **已确认**：`before_submit` 改为任务级一次性提交前干预，而非证据门禁。若模型选中尚未注入的 Module，则暂扣最终回答、注入 SOP 并让 Agent 继续；注入后系统不验证是否执行、不检查证据，也不再为其他 `before_submit` Module 拦截。
19. **已确认**：首版不实现证据规则 DSL、完成状态判断或 LLM 合规检查；`completionRule`、`requiredEvidence`、`recovery` 只作为指南内容提供给 Agent。
20. **已确认**：`no_progress` 在连续三次调用相同工具、规范化关键参数相同，且返回相同错误或没有新状态/产物时触发；同一重复片段只触发一次。
21. **已确认**：生产配置只保留 `off | legacy | package_v1`；`static | dynamic | full` 仅由 SpreadsheetBench 评测 Harness 控制，其中 full 比 dynamic 多提交前一次性干预。
22. **已确认**：离线构建以训练 Harness 输出的 Episode ID manifest 限定输入，不新增 `trainingRunId`，也不借用现有 `pipelineRunId`。
23. **已确认**：同一工具批的重叠事件先合并，只执行一次候选选择、互斥校验和 SOP 注入。
24. **已确认**：Direct Skill Hook 只入队，Runner 复用现有 `injectionCallback`/drain 路径完成唯一一次注入，不新增直接 `messages.push` 路径。
25. **本轮确认**：Goal 模式暂不实现；`goal_continuation` 直接跳过 Direct Skill Runtime，不维护 `sessionId + goalId` 状态，不定义 `goal_replan` 事件。
26. **已确认**：L3/L4 的执行契约是模型判级依据，不是投票后的代码降级规则；三路聚合结果仍是最终强度。
27. **已确认**：单 Span/Turn 抽取不生成跨 Module 的互斥关系；在强度聚合后执行一次 Package 级整理，同时完成合并分组和互斥分组。
28. **已确认**：工具调用少于 11 次的 Turn 直接构建 Module；达到门槛的 Turn 在一次 Span/Subgoal 调用中同时判定单/多目标并仅对多目标切 Span。
29. **已确认**：每个 Span 只发起一次结构化抽取调用，在同一响应中返回 Material 和 Candidate Module；Material 仅作为可追溯的内存中间结果。
30. **已确认**：Runtime 在现有任务轨迹/日志中追加 Package/事件/Module ID，通过 `taskKey` 关联已有的最终结果和用量记录；不重复存储 outcome，也不做迭代更新。
