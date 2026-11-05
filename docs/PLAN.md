# 演进总计划：AI 原生学习环境（数学 → 英语 → STEAM → 跨学科）

> 状态：**定稿，作为后续执行依据**（2026-11-04 第二版）
> 参考上游：OpenMAIC v1.4.0 @ `795420c1`（MIT），https://github.com/THU-MAIC/OpenMAIC
> 文中的数字来自对本仓库和 OpenMAIC 的实测，出处见各节。

---

## 第一部分：我们在做什么

### 一句话

把 MathTutor 从“数学练习 + 讲解工具”升级成一个**全部跑在本地的 AI 原生学习环境**。第一步覆盖数学和英语，接着扩展到物理等 STEAM 科目，最后支持跨学科探索。

### 什么叫“AI 原生”

“AI 原生”不是用 AI 生成课件给孩子看，而是让孩子学习的环境本身由 AI 构成：

1. **学新知识**：AI 课堂（讲解 → 停下来让孩子先答 → 小测 → 探索 → 小结），可以接到孩子手里的教材上。
2. **巩固**：练习、诊断、提示阶梯、变式验证、SM-2 复习（现有能力）。
3. **动手探索**：可操作的交互组件和虚拟实验。AI 不直接说答案，而是通过操作组件来引导孩子。
4. **开口表达**：英语口语对练、费曼式“教会 AI”、把探究结论讲出来。
5. **认识 AI**：看见 AI 怎么想，给 AI 挑错，比较不同模型；了解模型、数据、幻觉和隐私。
6. **跨学科**：用一个驱动问题串起多个学科的项目，证据分别计入各学科节点。

这六件事共用一套底座：学科无关的内核、一个导师代理、统一的证据和掌握度、统一的安全与家长控制。

### OpenMAIC 在其中的位置

OpenMAIC 的 AI 课堂做得很成熟，比如播放和动作引擎、可交互的场景、生成工具链。但它没有学习者模型，不遵守“不喂答案”，也不做验证。所以我们**不合并两个产品**，而是把其中与框架无关、确实有用的约 5k 行源码移植过来（清单见第七部分），移植后由本项目自行维护。

### 教学宪法（第二版）

1. 理解要靠行为验证。
2. 永不喂答案。语言学习例外：用重述纠错（recast）和逐步提示代替直接给答案。
3. 归因必须有证据。
4. 数形结合，或者说“看得见的表示”。
5. **未经验证的知识不承重**，并按验证等级明确落地：

| 验证等级 | 含义 | 例子 | 是否计入掌握度 |
|---|---|---|---|
| `executable` | 可执行验证 | 数学（SymPy）、物理（单位与仿真） | 计入 |
| `reference` | 有标准答案，或证据可在原文中定位 | 英语词汇、语法、阅读理解 | 计入 |
| `ai_unverified` | 只有 AI 的判断 | 作文、口语、开放回答 | **不计入**：只作为练习记录和建议，界面上明确标注“AI 判断，未验证” |

---

## 第二部分：关键决策

| # | 决策 | 结论 |
|---|---|---|
| D1 | 视频路线 | 网页时间轴播放器是默认路线；**Manim 是可选的高级路线**，专门承担它的独有特性。不做 HTML→MP4 录屏 |
| D2 | 语言 | 产品逻辑全部用 TypeScript。Python 只做**纯计算 worker**（SymPy、图形几何、Manim 校验/编译/渲染、ASR、神经 TTS、抽帧指标），不调用 LLM，不存数据，不做编排 |
| D3 | 前端 | React 19 + Tailwind 4，不换框架 |
| D4 | 后端 | Hono + SQLite（`node:sqlite`），以文件为优先 |
| D5 | 模型 | 统一使用一个 OpenAI 兼容客户端。oMLX 作为主模型（**地址和模型 id 预留，由维护者填写**）；`LOCAL_ONLY` 默认开启；云端只作兜底，并保留审计 |
| D6 | OpenMAIC | 选择性移植约 5k 行，不跟上游同步 |
| D7 | 多学科 | 采用**学科无关内核 + 学科包**。在 AI 课堂之前先完成内核改造（阶段 1） |
| D8 | 英语语音 | 做本地 ASR、本地神经 TTS 和 **AI 口语对练**；**不做发音打分** |
| D9 | 不可验证的评分 | 作文、口语等 `ai_unverified` 结果**不计入掌握度**，只作为练习记录和建议 |
| D10 | 导师 | **一个导师代理 + 多个学科技能**（SKILL.md 格式），不为每个学科各建一个代理 |

**唯一的原则**：同一件事只用一种技术实现；两种技术并存时，必须分工不重叠。新学科以“学科包”的形式接入（TS 加数据文件，需要计算时调用 worker），不引入新的技术路线。

---

## 第三部分：学科无关内核与学科包

### 3.1 现状：每一层都是数学专用的

| 层 | 现状（实测） | 扩展时会撞上的问题 |
|---|---|---|
| 知识图谱 | `data/knowledge/graph.json` 的 strand 只有 number-algebra / geometry / stats-prob / thinking；节点没有 subject 字段 | 无法放入其他学科，也无法表达跨学科关系 |
| 题型 | `packages/schema/src/knowledge.ts` 中 `answerType` 只有 numeric / expression / steps | 没有跟读、对话、作文、实验记录等题型 |
| 判卷 | `apps/server/src/grading.ts` 全是数值、中文数字、等式等价的判断 | 英语没有可执行验算的手段 |
| 视觉 | SceneSpec 的 17 种图元全是数学图元 | 物理需要受力、运动、场、电路等图元 |
| 语音 | 全仓库没有 ASR | 英语的听和说无从实现 |
| 导师 | 探索代理只有 `graph_query` 和 `find_similar` 两个工具 | 无法承载多学科能力 |

### 3.2 内核提供什么

- **图谱**：节点新增 `subject` 字段，现有节点默认为 `math`，**现有 id 不改**，避免影响已有的掌握度数据。新学科的节点 id 加学科前缀，例如 `en:present-simple`、`phys:lever`。
- **跨学科连接**：放在 `data/knowledge/links.json`，边有类型：`prerequisite`、`applies`（应用）、`analogy`（类比）、`evolves`（演进）。
- **掌握度 / SM-2 / 证据**：证据带上 `verification` 等级，掌握度投影会忽略 `ai_unverified`。
- **注册表**：题型（itemType）、判卷器（Judge）、验证器（Verifier）、视觉词汇（图元按学科分命名空间，例如 `phys.force_arrow`），都由学科包注册进来。
- **导师代理**：一个代理，学科能力以技能的形式放在 `skills/<subject>/*/SKILL.md`。工具集统一为：图谱查询、找相似、题库、验证器调用、组件操作、笔记、记忆。
- **课堂运行时、探索组件宿主、安全与家长控制、学习者画像与记忆、每日规划器**：全部与学科无关。

### 3.3 学科包需要提供什么

```
subjects/<subject>/
  graph.json          该学科的知识图谱（含学段、主线）
  item-types.ts       题型 schema
  judges.ts           判卷器：返回 verdict + verification 等级
  verifiers.ts        验证器：可执行或引用（按需调用 worker）
  visuals.ts          视觉词汇：图元 + 播放器渲染器
  widgets/            学科交互组件
  skills/             导师技能（SKILL.md）
  content/            词表、读物、实验等内容源
```

数学是第一个学科包：把现有代码平移过来，行为保持不变。

---

## 第四部分：视频路线——网页动画为默认，Manim 为高级选项

### 4.1 现状实测

数据来源：`data/math_tutor.sqlite`（2026-05 至 2026-08，共 24 个会话）和 `data/bench/throughput-001.json`。

- **端到端耗时**：出片会话中位数 317 秒，P90 为 602 秒；吞吐基准中位数 170.5 秒。
- **各阶段平均耗时**：
  - 共有阶段：solve 52 秒，verify 31 秒（成功率 19/36），direct 60 秒；
  - Manim 专有阶段：写 Manim 代码 **105 秒**，编译 12 秒，渲染 8 秒，VLM 审片 **164 秒**。
- **Manim 能力几乎没用上**：生成的代码以 Text、VGroup、FadeIn、Indicate、Line 为主；MathTex 只出现 1 次，ValueTracker 1 次，公式变形和 3D 为 0。目前是把 Manim 当幻灯片在用。
- **网页播放器的现状**：`packages/explainer-web` 已经能渲染全部 17 种图元，但现在每 3.2 秒切一拍（`setTimeout`），没有补间，也不能跳转。

### 4.2 分工

| | 网页时间轴播放器（默认） | Manim 高级视频（可选） |
|---|---|---|
| 场景 | 课堂、讲解、探索引导，覆盖所有学科 | 主动点“高级视频”，或课程中标记了 `needs_manim` 的场景 |
| 速度 | 秒级出现，可暂停、可交互 | 异步排队，结果缓存，课堂不等视频 |
| 擅长 | 数量关系、分步推理、图形标注、函数图像 | 公式逐项变形、参数连续变化、立体几何、线性变换；物理中的矢量场、波、轨迹 |
| 正确性 | 在 DOM 上核对数量，并与验证结果对拍 | AST 门禁 + 确定性帧指标；VLM 只做抽样，不进关键路径 |

### 4.3 让 Manim 名副其实

1. **特性模板**：公式变形、参数连续变化、3D、线性变换（后续增加物理的场、波、轨迹）。由 SceneSpec 加 Math IR 确定性地编译成代码；LLM 写代码只作兜底。
2. **离开关键路径**：异步执行；按“题目 + IR 哈希 + 年级”缓存；可夜间预生成；未就绪时先播网页版。
3. **质量门**：落实 `VISUAL_SEMANTICS_DESIGN.md`，以确定性核数作为硬门槛。
4. **触发规则写进 schema**：根据 IR 类型打 `needs_manim` 标记，不交给模型自由判断。

---

## 第五部分：英语与口语对练

### 5.1 英语学科包

| 模块 | 内容 | 验证等级 |
|---|---|---|
| 词汇 | 课标 / CEFR 词表；释义、例句、发音示范（TTS）；SM-2 复习 | reference |
| 语法 | 规则讲解（课堂）+ 选择 / 填空 / 改错 | reference |
| 阅读 | 分级读物；理解题的答案证据必须能在原文中定位 | reference |
| 听力 | 用 TTS 生成听力材料，配理解题 | reference |
| 写作 | 按量规给出反馈（结构、词汇、语法）；两次评分做一致性检查；家长可抽查 | ai_unverified，不计入掌握度 |
| 口语 | AI 口语对练（见 5.2） | ai_unverified，不计入掌握度 |

### 5.2 AI 口语对练

- **形式**：情景角色扮演（自我介绍、点餐、问路、购物、讲一个故事、描述图片），AI 扮演语伴；难度按 CEFR 等级调整。
- **语音链路**（全部在本地）：麦克风 → 本地 ASR（whisper.cpp 或 faster-whisper，放在 worker）→ 导师代理（英语技能）→ 本地神经 TTS（Kokoro 等，OpenAI 兼容的 `/audio/speech`，放在 worker）→ 播放。
- **纠错方式**：在对话中用重述纠错（recast），不打断交流；孩子卡住时可以用中文求助，AI 给出半句提示，而不是整句答案；可以调慢语速、重听。
- **结束后的反馈**：给出“你今天用到的表达 / 可以试试的说法”。**不打分，不计入掌握度**，只写入练习记录，例如时长、轮次、用到的词汇和句型。
- **不做**：发音打分、声学评测。
- **安全**：话题白名单；本地内容过滤；家长可查看对话转写；对话数据不出本机。

### 5.3 TTS 的变化

原计划用浏览器自带的 `speechSynthesis` 作兜底。英语的发音示范和口语对练需要本地神经 TTS，因此从“预留”提前为“英语阶段必需”。浏览器 TTS 保留为降级方案。

---

## 第六部分：目标架构

```
apps/
  server/              Hono 单体：内核 + 各学科路由 + 课堂 / 教材 / 口语 / 项目 / 视频任务（全部 TS）
  web/                 React 19：原有视图 + 课堂 / 教材 / 探索 / 口语 / 项目 / AI 实验台 / 家长中心
packages/
  schema/              zod 唯一真源（内核 schema + 学科注册接口）
  core/                【新】学科注册表、证据与验证等级、掌握度投影、每日规划器
  llm-client/          唯一 LLM 客户端：main / fast / vision / cloud + LOCAL_ONLY + 审计
  explainer-web/       → 升级为时间轴播放器（seek、补间、动作通道、DOM 断言，视觉词汇可插拔）
  classroom-runtime/   【新】课堂状态机（改写自 OpenMAIC playback + action）
  tutor/               【新】导师代理 + 技能加载 + 长期记忆
  safety/              【新】内容过滤、话题白名单、时长控制、对话留档
  generation/          【新】json-repair、生成重试、interactive 后处理与校验（改写自 OpenMAIC）
  widgets/             【新】交互组件宿主 + 通用组件；各学科组件放在学科包里
  knowledge/           原有
subjects/
  math/                第一个学科包（由现有代码平移而来）
  english/             第二个学科包
  physics/ …           后续学科包
skills/                导师技能（SKILL.md），按学科分目录
services/
  video-engine/ → compute-worker/   Python 纯计算：
      /v1/math/execute       Math IR → SymPy
      /v1/figure/*           图形几何
      /v1/manim/{validate,compile,render}
      /v1/video/metrics      抽帧指标
      /v1/asr                本地语音识别
      /v1/tts                本地神经 TTS（OpenAI 兼容 /audio/speech 语义）
      /v1/contract
```

### 模型配置

oMLX 的位置已在 `.env.example` 中预留：

```
# LLM_API_BASE=<oMLX 地址>/v1
# LLM_MODEL=<oMLX 模型 id，例如 qwen3.8-next-flash>
# LOCAL_ONLY=1
# LLM_CLOUD_API_BASE=
# LLM_CLOUD_MODEL=
```

- embedding / rerank 仍走 LMStudio（bge-m3 / bge-reranker）。
- 在确认 oMLX 是否支持视觉之前，视觉判卷沿用 `LLM_VISION_*`。
- worker 端口改为 8100，避免与 oMLX 可能占用的 8000 冲突。

---

## 第七部分：阶段计划

> 工期为一人全职粗估。**每个阶段的通用要求**：`pnpm -r build && pnpm -r test` 全绿，pytest 全绿，Playwright 冒烟全绿；使用独立分支、小步提交；不满足 DoD 不进入下一阶段。
> **贯穿全程的学习效果评估**：每个学科包上线时都要附带前测、后测、迁移题和保持率追踪（第 1 周和第 4 周）。只有数据证明“AI 原生”的方式比单纯刷题更有效，才算完成。

### 阶段 0：安全网与基线（1–2 周）
- 现有 9 个视图的 Playwright 冒烟测试。
- 引擎黄金集：从 437 个 pytest 用例和 `data/sessions` 中整理。
- 视频黄金题集 30 道以上，其中至少 8 道属于 Manim 特性类。
- 填好 oMLX 后跑一次回归基线：判卷准确率、门禁通过率、耗时。
- 新增 `pnpm verify`，一条命令完成全部检查。
- **DoD**：三套基线入库，`pnpm verify` 可用。

### 阶段 1：学科无关内核（2–3 周）
- 图谱节点增加 `subject` 字段，新增 `links.json` 存放带类型的边，现有 id 不变。
- 题型、判卷器、验证器、视觉词汇改为注册表；数学平移为 `subjects/math`。
- 证据增加 `verification` 等级，掌握度投影忽略 `ai_unverified`。
- 导师代理改为“一个代理 + 技能”，现有探索代理迁移为数学技能。
- **DoD**：数学行为完全不变，现有测试全绿；另用一个最小的 `subjects/english` 骨架（几张词汇卡加一个判卷器），证明不修改内核也能接入新学科。

### 阶段 2：网页时间轴播放器（2–3 周）
- `seek(tMs)`、`duration`，渲染结果确定；数量动词都有补间，并且有明确的起点和终点。
- 动作通道：spotlight / reveal / annotate / setState。
- KaTeX 公式按 token 动画。
- 视觉词汇可插拔，支持学科命名空间。
- DOM 断言库。
- **DoD**：现有 SceneSpec 截图对比通过；同一时刻 t 的渲染逐像素一致；VISUAL_SEMANTICS 中的 3 个反例都被判为失败；删除旧的 `setTimeout` 切拍逻辑。

### 阶段 3：AI 课堂、教材编译器、探索、AI 实验台（数学，5–7 周）
- **课堂**：
  - 两种生成方式：compose（确定性、离线可用）和 generate（oMLX → json-repair → zod，失败退回 compose；生成的答案必须经过验证器）。
  - 以旁白为时钟；作答写入 attempt（source=`classroom`）。
  - 暂停提问时，从上下文中剔除本课答案。
- **教材编译器**（仅家长）：PDF → 章节（书签 → 启发式 → LLM）→ 知识点 → 图谱对齐（关键词 → bge-m3 → reranker）→ 候选节点需家长确认，绝不直接写入图谱 → 按先修关系排出课程计划。教材编译器从一开始就与学科无关。
- **探索组件**：移植 OpenMAIC 的 interactive 宿主和动作协议；首批 10 个数学组件；自由生成的 HTML 作为兜底，并做沙箱、库锁定和脚本校验；结束时用一道变式题收尾，结果写回证据。
- **AI 实验台（轻量版）**：复用 AgentTimeline，展示提示词摘要、工具调用、耗时；支持调温度、双模型对比。
- **DoD**：
  - 课堂：断点续学；提问后能回到原场景；TTS、生成、视频各自失败时都能降级；对外 JSON 中没有 answer、salt、hash、analysis；各孩子之间隔离；`LOCAL_ONLY` 下零云端调用；断网时能上完一节 compose 课。
  - 教材编译幂等，并有对齐评测集。
  - 组件沙箱有测试锁住。

### 阶段 4：横切能力（2–3 周，**必须在任何开放对话上线之前完成**）
- **内容安全**：本地内容过滤（输入和输出两侧）、话题白名单、越界时转移话题并记录。
- **时长与健康**：每日时长上限、休息提醒、家长可配置。
- **家长中心**：查看对话转写、学习轨迹、AI 判断（未验证）的抽查队列；可以关闭任意模块。
- **学习者画像**：兴趣、目标、偏好的表示方式，用于个性化（例如用孩子感兴趣的主题出题）。
- **导师长期记忆**：可解释、家长可查看和删除，只存在本地。
- **跨学科每日规划器**：在时长预算内分配新课、复习、探索、口语和项目。
- **DoD**：有红队测试集（越界话题、诱导要答案、隐私探询），全部被拦截或妥善转移；时长上限在前后端都生效；记忆可以删除，删除后确实不会被再召回。

### 阶段 5：英语学科包 + AI 口语对练（4–6 周）
- worker 新增 `/v1/asr`（whisper）和 `/v1/tts`（本地神经 TTS）。
- 词汇（含 SM-2）、语法、分级阅读（证据可定位）、听力。
- 写作按量规给反馈（ai_unverified）。
- AI 口语对练：情景角色扮演、重述纠错、中文求助只给半句提示、可调语速，结束后给出表达建议；不打分，不计入掌握度。
- 英语课堂：复用课堂运行时，视觉词汇用卡片、时间线、图文。
- **DoD**：
  - 断网时能完整完成一次口语对练（从 ASR 到导师再到 TTS），单轮延迟目标 ≤ 3 秒，并记录 P50 和 P90。
  - `ai_unverified` 证据不影响掌握度（有测试锁住）。
  - 话题白名单和过滤对口语对练生效。
  - 词汇、阅读的前后测数据入库。

### 阶段 6：Manim 高级路线（3–4 周）
- 特性模板：公式变形、参数连续变化、3D、线性变换；schema 中加入 `needs_manim`；异步执行、缓存、夜间预生成；以确定性质量门为主，VLM 只做抽样。
- **DoD**：黄金题集中特性类题目都用上了对应的 Manim 特性；模板覆盖的题目不需要 LLM 写代码；中位耗时比基线降低 40% 以上；VISUAL_SEMANTICS 中的各类缺陷都会被门禁拦下。

### 阶段 7：物理 / STEAM 学科包（每个学科 4–6 周）
- **验证器**：量纲与单位检查（mathjs 单位系统）、数值仿真。
- **视觉词汇**：受力、运动轨迹、电路、光路等。
- **交互组件**：2D 物理（matter.js / planck.js）、three.js；虚拟实验采用完整的闭环：改参数 → 记数据 → 画图 → 下结论。
- **Manim 模板**：新增物理特性模板，如矢量场、波、轨迹。
- **工程与艺术**：积木编程（Blockly 生成 JS，在现有 iframe 沙箱中运行）。
- **DoD**：每个虚拟实验都有仿真结果与理论值对拍的测试；物理题经过单位验证器。

### 阶段 8：跨学科探索与 AI 素养（3–4 周）
- **项目制学习（PBL）**：一个驱动问题，挂多个学科的节点，包含里程碑、产出物和评分量规；证据分别计入各节点。参考 OpenMAIC PBL v3 的设计，不移植其代码。
- **统一探究流程**：提问 → 假设 → 实验 → 数据 → 结论 → 讲给别人听（英语也可以作为表达载体）。
- **跨学科连接**：由 `links.json` 驱动“这个知识在别的学科里怎么用”。
- **给 AI 挑错**：AI 故意犯错，由孩子找出来，适用于所有学科。
- **费曼模式**：AI 扮演听不懂的学生，孩子来教它。
- **AI 素养课程**：按年龄分级，涵盖模型、数据、偏见、幻觉、提示、隐私、负责任地使用，全部用本地栈演示。
- **作品集**：笔记、实验、项目、口语记录。
- **DoD**：至少 3 个样板跨学科项目（数学 + 物理 + 英语）可以完整走通；AI 素养课程有配套的理解检查。

### 阶段 9：引擎编排迁到 TS（6–10 周，可按需推迟）
- 迁移顺序：统一 LLM 客户端和配置 → solve → verify（修复 19/36 的成功率）→ direct → Manim 兜底写码与 VLM 抽样 → 存储 → learned_wiki。
- 每个环节用 `ENGINE_IMPL=python|ts` 双轨运行，并与黄金集对拍；**对等后立即删除对应的 Python 代码**。
- **DoD**：worker 不导入任何 LLM 或存储模块；网关启动时校验契约。

---

## 第八部分：OpenMAIC 移植清单（约 5k 行，MIT）

| 来源 | 行数 | 去向 |
|---|---|---|
| `lib/playback/*` | 1,688 | classroom-runtime |
| `lib/action/engine.ts` | 912 | classroom-runtime |
| `components/scene-renderers/{interactive-renderer,InteractiveIframeHost,InteractiveRuntimeErrorBanner}.tsx` | 按需 | widgets |
| `lib/store/interactive-iframe-pool.ts` | 212 | widgets |
| `components/scene-renderers/quiz-*.tsx` | 按需 | 课堂小测（改为由服务端判定） |
| `components/whiteboard/*` | 899 | 课堂白板（可选） |
| `@openmaic/generation`：json-repair、generation-retry、interactive-post-processor、interactive-script-validator、library-mapper、libraries | 1,258 | generation |
| `@openmaic/generation/templates/{simulation,diagram,game}-content` | 提示词 | 组件自由生成的兜底（改写为各学科专用版本） |

- **不移植**：`@openmaic/renderer`（PPT 式画布）、agent-runtime / pbl-v3（依赖 Postgres；PBL 只参考设计）、importer、`mathml2omml`（LGPL）、GSAP / Hyperframes、云端媒体 provider。
- **署名**：每个文件头写明 `Adapted from OpenMAIC <path> @795420c1 (MIT)`，并新增 `THIRD_PARTY_NOTICES.md`。

---

## 第九部分：删除清单（可维护性承诺）

| 删除对象 | 阶段 | 前提 |
|---|---|---|
| 数学专用的硬编码分支（判卷、题型、图元直连） | 1 | 已平移到 `subjects/math` 和注册表 |
| explainer-web 中 `setTimeout` 切拍的逻辑 | 2 | 新播放器通过截图对比 |
| 以 LLM 自由写 Manim 代码为主的路径 | 6 | 特性模板覆盖黄金题集，LLM 写码降为兜底 |
| Python LLM 客户端（952 行）和配置（789 行） | 9 | TS 版对等 |
| Python 编排、存储、wiki | 9 | 逐个环节对等 |

**保留**：Manim 及其工具链（作为高级路线）、SymPy、图形几何、ASR、TTS（均在 compute-worker 中）。

---

## 第十部分：风险与应对

| 风险 | 应对 |
|---|---|
| 内核抽象过早或过度 | 阶段 1 只抽象数学和英语都用得上的部分，并用英语骨架验证；物理到来时再按需扩展 |
| 开放对话带来的安全风险 | 阶段 4 是硬前置；红队测试集纳入 CI |
| 本地 ASR / TTS 的延迟 | 优先选小模型、流式处理；设定 3 秒目标并持续记录 P50 / P90 |
| 网页播放器表现力不足 | 分工写进 schema；表现力不够的部分交给 Manim |
| oMLX flash 模型输出 JSON 不稳 | json-repair + zod + 重试一次 + compose 兜底；关键环节可改走 main 层 |
| 多学科内容的可信度 | 以课标和教材为依据，多模型交叉一致，标注验证等级，家长审核是唯一入口 |
| 一个人的精力 | 阶段 0–5 交付数学和英语；6–8 按兴趣和需要推进；9 可以推迟 |

---

## 附录：本计划的形成过程

1. 评估 OpenMAIC：MIT 许可，可完全自托管，但没有学习者模型 → 结论是互补，不替代。
2. 技术栈收敛：保留 React（与 OpenMAIC 同栈）；Python 收敛为纯计算 worker。
3. 视频路线：网页播放器为默认，Manim 作为高级选项并用上它的特性；不做 HTML→MP4。
4. 多学科：确认采用学科无关内核 + 学科包，先做内核再做课堂。英语做 AI 口语对练，不做发音打分；不可验证的评分不计入掌握度。
