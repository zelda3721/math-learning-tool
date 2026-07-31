# 🎓 AI Math Tutor

> 把一道数学题变成可播放的 Manim 教学动画。

---

## ✨ 它能做什么

- 输入数学题 + 选年级 → 生成 Manim 解题动画
- 实时显示生成流水线：每个工具调用、参数、结果都通过 SSE 推到前端
- 每次对话、生成的代码、最终视频都本地落库（SQLite + 文件系统）
- 你可以对每次结果打 👍/👎；反馈会进入候选—复现—晋升学习流程
- 不枚举题型、不向生产提示词注入相似题代码；视觉方案由当前数学语义生成
- Solve/Verify 把模型结论编译为安全 Math IR，并由 SymPy 独立计算、验算
- 可绘制的数学证据直接降低为 Visual IR；确定性编译器优先生成 Manim，不必反复重写整份代码
- 渲染后结合确定性技术检测和多模态模型评审；只有明确证据时才进行一次局部修复
- 历史页展示首轮通过率、数学一致性、技术规格、阶段耗时与重试次数

---

## 🏗️ 架构

```
┌──────────────────────────────────────────────────────────────┐
│            Frontend (React 19 + Vite + Tailwind)              │
│  ProblemInput → SSE 实时事件流 → AgentTimeline + LiveResult   │
│  反馈条 / 历史会话抽屉 / 只读历史查看                          │
└────────────┬─────────────────────────────────────────────────┘
             │ POST /api/v1/chat (text/event-stream, fetch)
┌────────────▼─────────────────────────────────────────────────┐
│          Backend (FastAPI + bounded workflow)                 │
├──────────────────────────────────────────────────────────────┤
│  有界状态机：只暴露合法下一步；正常路径无需控制器 LLM 调用     │
├──────────────────────────────────────────────────────────────┤
│  3 个生产 endpoint，留空 fallback 主 LLM：                     │
│   • LLM provider       (OpenAI 兼容协议) ← LMStudio / vLLM    │
│   • Vision provider    (多模态)         ← Qwen-VL / 复用主 LLM │
│   • Fast provider      (分析/求解/规划)  ← 小模型 / 复用主 LLM  │
├──────────────────────────────────────────────────────────────┤
│  ToolRegistry — 5 个产品阶段（严格按证据状态推进）：           │
│      • Solve    问题事实简报 + 结构化解答 + Math IR             │
│      • Verify   独立 Math IR / 逻辑 / 反例审计                  │
│      • Direct   数学证据 → Visual IR；否则开放式 SceneSpec     │
│      • Compile  确定性 IR 编译优先 + 门禁 + 720p30 渲染         │
│      • Watch    抽帧 + 技术指标 + 数学/教学评审                 │
│  Compile/Watch 的内部动作不再显示成独立失败；各自最多一次       │
│  由具体错误或帧证据驱动的修复。                                │
├──────────────────────────────────────────────────────────────┤
│  MathRuntime：白名单 AST → SymPy 精确运算 → claims 验证        │
│  Visual IR：可组合图元 + 因果动作 → 无任意代码的 Manim 场景    │
├──────────────────────────────────────────────────────────────┤
│  LearnedWiki：candidate 隔离 → 3 个独立 session 复现 → 晋升    │
│  QualityReport：首轮成功/数学一致性/技术门禁/耗时/重试          │
│  ConversationStore + FileArchive (SQLite + 文件系统)           │
└──────────────────────────────────────────────────────────────┘
```

生产链路不按题型路由。状态机只负责依赖和失败回退，LLM 把当前问题编译为紧凑的数学与
视觉中间表示；确定性运行时负责计算、验算、采样、布局和优先渲染。大段代码保存在
state/artifact 中，不回灌控制器上下文。

### 从数学证据到视频

```
题目
  → Solve：结构化解答 + Math IR
  → Verify：独立构造并执行 Math IR
  → Direct：验证证据 → 可绘制对象、稳定含义、因果动作
  → Compile：Visual IR → Manim → MP4
  → Watch：技术指标 + 抽帧数学/教学审查
```

- Math IR 是能力协议，不是题型表。模型声明符号、表达式、操作和 claims；运行时支持精确化简、
  展开、因式分解、微分、积分、极限、求解、代入、行列式、求和与连乘等可组合操作。
- 表达式只经过白名单 AST 解析，不执行模型生成的任意 Python。
- 当验证证据包含可绘制的一元表达式时，系统可直接安全采样函数曲线并构造视觉论证；
  一元方程的精确实根会直接降低为曲线零点与坐标投影（支持多根）；不可无损降低的内容仍
  交给开放式视觉导演，而不是增加题型分支。
- 题目卡总是在视频开头出现。坐标对象保持真实数据坐标；空心点、易读刻度和标签分区由
  编译器统一处理，避免公式依赖、双字幕和末段遮挡。
- Visual IR 会在本地归一化等价但不规范的模型输出：安全 Math IR 简写、坐标点/多点、
  `start/end` 线段、派生曲线叠加、辅助线揭示和自变换都会局部降低为可执行语义；不会为
  某道题新增分支，也不会因为轻微 schema 差异重新生成整份计划。

---

## 📁 关键目录

```
math-learning-tool/
├── backend/src/math_tutor/
│   ├── api/
│   │   ├── main.py
│   │   └── routes/
│   │       ├── chat.py          # POST /api/v1/chat (SSE 推荐)
│   │       ├── problems.py      # POST /api/v1/problems/process (同步包装)
│   │       ├── sessions.py      # 历史 / 反馈 / 质量趋势 / 字幕
│   │       ├── grades.py / skills.py / health.py / videos.py
│   ├── application/interfaces/  # ILLMProvider/IEmbeddingProvider/
│   │                            # IRerankProvider/ISkillRepository/
│   │                            # IVideoGenerator/ITool
│   ├── domain/                  # 实体与值对象
│   ├── infrastructure/
│   │   ├── agent/
│   │   │   ├── loop.py          # 有界状态机 + SSE 事件
│   │   │   ├── prompt_composer.py # 兼容自由控制器的系统提示
│   │   │   ├── prompt_library.py  # 外置模板加载器
│   │   │   ├── prompt_templates/  # 各阶段紧凑契约
│   │   │   ├── math_runtime.py     # 安全 Math IR / SymPy 执行与函数采样
│   │   │   ├── markdown_extract.py # markdown→结构化数据
│   │   │   ├── learned_wiki.py    # 候选/跨会话晋升
│   │   │   ├── quality_metrics.py # 内容无关质量指标
│   │   │   ├── tool_registry.py
│   │   │   └── tools/             # 5 个产品阶段 + 可单测的内部编译组件
│   │   ├── llm/                   # 3 个 OpenAI 兼容 provider
│   │   ├── manim/                 # Manim 执行器
│   │   ├── media/                 # 字幕时间轴与可选 TTS 混流
│   │   ├── skills/                # 旧离线素材；不进入生产路由
│   │   └── storage/               # SQLite + 文件归档
│   └── config/                    # settings + dependencies (DI)
├── frontend/src/
│   ├── App.tsx                  # 主入口（SSE 流式 + 历史抽屉）
│   ├── components/              # AgentTimeline / FeedbackBar / 等
│   ├── hooks/useAgentRun.ts     # SSE 事件 → reducer → UI state
│   ├── services/sseClient.ts    # fetch + ReadableStream SSE 解析
│   └── types/agent.ts
├── scripts/
│   ├── diagnose_lmstudio.py     # 诊断 LMStudio/endpoint 故障
│   └── setup_latex.sh
├── data/                        # SQLite + 会话归档 + learned_rules.md
├── media/                       # Manim 输出
├── docker-compose.yml
└── backend/Dockerfile  + frontend/Dockerfile
```

---

## 🚀 快速开始

### 1) 启动本地 LLM 栈

最简版本：仅 LMStudio 跑 chat（embedding/rerank/vision 都先不开，回退到关键词）。

```bash
# 在 LMStudio 加载 qwen/qwen3.6-35b-a3b（或任何 OpenAI 兼容模型）
# 启动 OpenAI 兼容服务器，监听 http://localhost:1234
# 模型加载页找 "Thinking" toggle，关掉（重要！）
```

进阶版本：再加一个 `infinity` 同时跑 embedding + rerank：

```bash
pip install "infinity-emb[all]"
infinity_emb v2 \
  --model-id BAAI/bge-m3 \
  --model-id BAAI/bge-reranker-v2-m3 \
  --port 8090
```

### 2) 配置 .env

```bash
cp .env.example .env
# 主 LLM 默认指向 LMStudio + qwen3.6-35b-a3b
# 已验证模型名示例：LLM_MODEL=qwen/qwen3.6-35b-a3b
# OpenAI 兼容端点需要包含 /v1，例如 LLM_API_BASE=http://localhost:1234/v1
# Vision/Embedding/Rerank 留空 = 自动回退（不影响主链路）
# 如装了 infinity：
#   LLM_EMBEDDING_API_BASE=http://localhost:8090
#   LLM_EMBEDDING_MODEL=BAAI/bge-m3
#   LLM_RERANK_API_BASE=http://localhost:8090
#   LLM_RERANK_MODEL=BAAI/bge-reranker-v2-m3
#   LLM_RERANK_API_TYPE=cohere
#   LLM_RERANK_ENABLED=true
```

### 3) 启动后端

```bash
conda activate math_learning_tool   # 或你的 Python ≥3.10 环境
pip install -e backend/
cd backend && python -m math_tutor.api.main
# 监听 http://localhost:8000
```

启动日志应能看到：

```
PromptLibrary loaded 11 templates: ['analyze', 'audit_manim_semantics', 'audit_solution_consistency', 'audit_visual_plan', 'generate_manim', 'inspect_video', 'match_skill_llm', 'solve', 'verify_solution', 'visual_plan', 'wiki_ingest']
OpenAILLMProvider ready (base_url=..., model=qwen/qwen3.6-35b-a3b, bypass_proxy=True)
```

### 4) 启动前端

```bash
cd frontend && npm install && npm run dev
# 访问 http://localhost:5173
```

### 5) 玩起来

- 选年级，输入数学题，提交
- 右侧实时看到五阶段证据链：Solve → Verify → Direct → Compile → Watch
- 视频出来后用反馈条打 👍/👎；反馈先进入隔离候选区，不会把单题代码注入生产提示词

### Docker 一键

```bash
docker compose up -d --build
# 前端 http://localhost:3000
# 后端 http://localhost:8000
# LMStudio 必须跑在宿主机的 1234 端口（容器通过 host.docker.internal 访问）
```

---

## 📡 API

### `POST /api/v1/chat` （推荐，SSE 流）

```bash
curl -N -X POST localhost:8000/api/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"problem":"鸡兔同笼，头35脚94","grade":"elementary_upper"}'
```

事件类型：`session / text / reasoning / tool_call / tool_result / done / error`

### `POST /api/v1/problems/process` （同步，向下兼容）

内部仍跑 AgentLoop，drain 后返回一个汇总 JSON。

### 会话与反馈

```bash
curl localhost:8000/api/v1/sessions?label=good
curl localhost:8000/api/v1/sessions/<session_id>

curl -X POST localhost:8000/api/v1/sessions/<id>/feedback \
  -H "Content-Type: application/json" \
  -d '{"label":"good","notes":"假设法很清晰"}'

# 把这次代码加入示例库（多次重试时取最后一次成功的）
curl -X POST localhost:8000/api/v1/sessions/<id>/promote_example \
  -H "Content-Type: application/json" \
  -d '{"label":"good","tags":["鸡兔同笼","假设法"]}'
```

---

## 🧠 数据如何变成下次的提示

```
session 五阶段证据 + Watch 质量报告 + 用户反馈
  → ingester 只提炼与题目/题型无关的通用机制
  → candidates/ 隔离（生产不可检索）
  → 同一机制由至少 3 个独立 session 复现
  → 晋升到 lessons/
  → 仅在匹配具体运行错误时作为短 KB 片段检索
```

单次会话、单题代码、相似题样例和 `data/learned_rules.md` 不进入冷启动生产提示词。

---

## ⚙️ 配置（.env）

| 变量 | 用途 | 默认 |
|---|---|---|
| `LLM_API_BASE/KEY/MODEL` | 主 LLM endpoint | LMStudio + qwen3.6-35b-a3b |
| `LLM_EXTRA_BODY` | 透传给 OpenAI 客户端的 extra_body（JSON） | 空 |
| `LLM_DISABLE_THINKING_WITH_TOOLS` | 工具调用时强制 enable_thinking=false | true |
| `AGENT_DETERMINISTIC_WORKFLOW` | 有界状态机直接调度，跳过控制器 LLM | true |
| `LLM_VISION_*` | 视觉模型 endpoint（Watch 成片审查用） | 空 = 复用主 LLM |
| `LLM_EMBEDDING_*` | embedding endpoint | 空 = 禁用语义检索 |
| `LLM_RERANK_*` | reranker endpoint | 空 = 禁用精排 |
| `LLM_RERANK_API_TYPE` | `cohere` 或 `tei` | cohere |
| `LLM_RERANK_ENABLED` | 显式开关（即使配 model 也能临时关） | true |
| `MANIM_QUALITY` | low / medium / high | medium |
| `MANIM_USE_LATEX` | 是否启用 LaTeX | false |
| `MANIM_RENDER_TIMEOUT_S` | 单次渲染超时 | 300 |
| `NARRATION_SUBTITLES_ENABLED` | 从 visual beat 导出 WebVTT 字幕 | true |
| `NARRATION_TTS_ENABLED` | 调用兼容 `/audio/speech` 的 TTS 并混入音轨 | false |
| `NARRATION_TTS_*` | 独立 TTS endpoint / model / voice / speed | 空 |
| `LEARNED_WIKI_ENABLED` | 启用候选—跨会话晋升学习 | false |
| `DATA_DIR` | 数据目录（SQLite + 归档） | ./data |

---

## 📊 质量指标

- 单会话：`GET /api/v1/sessions/{id}` 的 `quality` 字段
- 聚合与前后窗口趋势：`GET /api/v1/sessions/metrics/quality?trend_window=10`
- 指标不按题型分桶：首轮通过、B 段教学分、数学一致性、本质兑现、分辨率/帧率、
  实际/计划时长、字幕/旁白可访问性、工具耗时、重试次数和质量回归。

---

## 🛠️ 故障诊断

```bash
# LLM endpoint 通不通？哪个字段出问题？
python scripts/diagnose_lmstudio.py            # 完整请求
python scripts/diagnose_lmstudio.py --no-tools # 不带工具
python scripts/diagnose_lmstudio.py --tool solve_problem
python scripts/diagnose_lmstudio.py --print-curl --dump-body /tmp/req.json
```

---

## ✅ 测试

```bash
uv sync --project backend --extra dev
backend/.venv/bin/pytest -q backend/tests
cd frontend && npm run build && npm run lint
```

前端端到端验收建议至少检查：

1. Solve 与 Verify 的 Math IR 都通过，并且没有依赖模型心算得出最终数值。
2. Direct/Compile 首次成功；重试只作为有明确错误证据时的兜底。
3. 视频开头完整显示题目，核心数学变化由图形表达，不是依次罗列文字或对象。
4. 抽查中段和末段帧：无双字幕、标签遮挡、坐标漂移或错误的实心/空心点。

---

## 🛣️ 设计原则

1. **有界而开放**：工作流依赖固定，数学内容和视觉方案开放；不枚举题型
2. **跨工具记忆**：`ToolContext.state` 在工具间共享，agent 不必每次重复传上下文
3. **可追溯可复现**：每次对话、参数、结果、artifact 全落 SQLite + 文件系统
4. **反馈是证据**：good/bad 反馈先隔离，跨会话复现后才晋升为生产知识
5. **端点分层可配**：主 LLM / Fast LLM / Vision endpoint 独立配置
6. **紧凑阶段契约**：每个工具只接收当前阶段所需信息，大产物不回灌上下文
7. **双重成片门禁**：确定性技术检测 + 多模态数学/教学评审，失败自动修复
8. **同源讲解轨道**：画面字幕、WebVTT 和可选旁白共享 visual plan 时间轴
9. **数学先执行后表达**：模型声明 Math IR，确定性工具计算与验算，视频只消费已验证证据
10. **重试只是兜底**：优先修复局部结构；没有可定位证据时停止，不进行无限整稿重生成

---

## 📄 License

MIT

## 🙏 致谢

- [Manim Community](https://www.manim.community/)
- DispatchMind — harness agent 蓝本
- [Claude Code](https://claude.com/claude-code) — 设计哲学参考
- [Anthropic Skills](https://github.com/anthropics/skills) — 技能系统参考
- [BGE](https://huggingface.co/BAAI) — 推荐的 embedding/reranker 模型
