# 🎓 AI Math Tutor

> 把一道数学题变成可播放的 Manim 教学动画。
> 架构借鉴 Claude Code / DispatchMind 的 harness agent 思想，使用本地 LLM（默认 LMStudio + Qwen3.6），全链路对话与代码本地持久化，支持人类反馈闭环。

---

## ✨ 它能做什么

- 输入数学题 + 选年级 → 生成 Manim 解题动画
- 实时显示 agent 的思考链：每个工具调用、参数、结果都流式推到前端
- 每次对话、生成的代码、最终视频都本地落库（SQLite + 文件系统）
- 你可以对每次结果打 👍/👎，把好/坏样本加入示例库
- 下次类似题目时，示例库自动作为 few-shot + embedding 语义检索注入到 prompt
- 渲染后用多模态模型自动评审视觉质量；有问题自动回到代码生成修复
- 工具调用并行（阶段 A 三个工具一轮里同时跑）

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
│              Backend (FastAPI + 自研 AgentLoop)               │
├──────────────────────────────────────────────────────────────┤
│  AgentLoop (async generator) — 每 turn 流式 LLM + 并行工具    │
├──────────────────────────────────────────────────────────────┤
│  4 个独立 endpoint，留空 fallback 主 LLM：                     │
│   • LLM provider       (OpenAI 兼容协议) ← LMStudio / vLLM    │
│   • Vision provider    (多模态)         ← Qwen-VL / 复用主 LLM │
│   • Embedding provider (语义检索)       ← bge-m3 / 关键词回退  │
│   • Rerank provider    (二阶段精排)     ← bge-reranker-v2-m3   │
├──────────────────────────────────────────────────────────────┤
│  ToolRegistry — 8 个内置工具（阶段 A 可并行）：                │
│    阶段 A — 并行收集（同一轮 emit）                            │
│      • analyze_problem       题目结构化分析                    │
│      • match_skill           匹配技能（关键词→embedding→LLM）  │
│      • search_examples       历史 good/bad 案例（embed+rerank）│
│    阶段 B — 串行解题                                           │
│      • solve_problem         结构化解题（步骤+答案+可视化提示）│
│    阶段 C — 串行生成与校验                                     │
│      • generate_manim_code   生成/修复 Manim 代码              │
│      • validate_manim_code   静态语法+质量+重叠检测            │
│    阶段 D — 串行执行与视觉评审                                 │
│      • run_manim             渲染视频                          │
│      • inspect_video         多模态评审 → 触发再生成           │
├──────────────────────────────────────────────────────────────┤
│  PromptLibrary — 5 个外置 markdown 模板（可手编、热加载）      │
│  PromptComposer — 主 system prompt（身份/工作流/规则/年级）    │
│  LearnedMemory — data/learned_rules.md（用户手编沉淀规则）     │
│  ConversationStore + FileArchive (SQLite + 文件系统)           │
│  ExamplesStore + SemanticIndex (embedding 缓存 + 余弦相似度)   │
│  SkillEngine (24+ 题型 markdown + 10 个通用可视化模式)         │
└──────────────────────────────────────────────────────────────┘
```

整条链路是一个 agent 在循环里看着工具结果自己决策——没有跨节点失忆，没有规则冲突，错误能针对性修复。

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
│   │       ├── sessions.py      # 历史 / 反馈 / 推送 example
│   │       ├── grades.py / skills.py / health.py / videos.py
│   ├── application/interfaces/  # ILLMProvider/IEmbeddingProvider/
│   │                            # IRerankProvider/ISkillRepository/
│   │                            # IVideoGenerator/ITool
│   ├── domain/                  # 实体与值对象
│   ├── infrastructure/
│   │   ├── agent/
│   │   │   ├── loop.py          # AgentLoop (并行 tool_calls)
│   │   │   ├── prompt_composer.py # 主 agent 系统提示
│   │   │   ├── prompt_library.py  # 外置模板加载器
│   │   │   ├── prompt_templates/  # 5 个 markdown 模板
│   │   │   ├── markdown_extract.py # markdown→结构化数据
│   │   │   ├── learned_memory.py
│   │   │   ├── tool_registry.py
│   │   │   └── tools/             # 8 个工具
│   │   ├── llm/                   # 3 个 OpenAI 兼容 provider
│   │   ├── manim/                 # Manim 执行器
│   │   ├── skills/                # SkillRepository
│   │   │   └── definitions/
│   │   │       ├── visualization/ # 24+ 题型 skill
│   │   │       └── patterns/      # 10 个通用可视化模式
│   │   └── storage/               # SQLite + 文件 + Semantic 检索
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
PromptLibrary loaded 5 templates: ['analyze', 'generate_manim', 'inspect_video', 'match_skill_llm', 'solve']
OpenAILLMProvider ready (base_url=..., model=qwen/qwen3.6-35b-a3b, bypass_proxy=True)
Loaded 24 skills, 10 patterns, and 5 agent prompts
```

### 4) 启动前端

```bash
cd frontend && npm install && npm run dev
# 访问 http://localhost:5173
```

### 5) 玩起来

- 选年级，输入数学题，提交
- 右侧实时看到 agent 思考链：分析 → 解题 → 匹配技能/查例子（并行）→ 生成代码 → 校验 → 渲染 → 视觉评审
- 视频出来后用反馈条打 👍/👎，可勾选"加入示例库"

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
检索 examples 流程（按可用度自动选）：
  ├─ rerank 二阶段精排（embedding top-N → rerank top-K）  ← 最准
  ├─ embedding 单阶段语义                                   ← 较准
  └─ 关键词 substring                                       ← 兜底

匹配 skills 流程（同一原则）：
  ├─ 关键词 substring（很快）
  ├─ embedding（鸡兔题 → 命中 chicken_rabbit 即使没 substring 命中）
  └─ LLM 全列表挑（最慢但最聪明）

匹配 patterns（10 个通用可视化模式）：
  ├─ embedding 排序（有 embedding endpoint 时）
  └─ 关键词兜底
```

加上 `data/learned_rules.md` 用户手编规则，每次新对话都重新读，无需重启。

---

## ⚙️ 配置（.env）

| 变量 | 用途 | 默认 |
|---|---|---|
| `LLM_API_BASE/KEY/MODEL` | 主 LLM endpoint | LMStudio + qwen3.6-35b-a3b |
| `LLM_EXTRA_BODY` | 透传给 OpenAI 客户端的 extra_body（JSON） | 空 |
| `LLM_DISABLE_THINKING_WITH_TOOLS` | 工具调用时强制 enable_thinking=false | true |
| `LLM_VISION_*` | 视觉模型 endpoint（inspect_video 用） | 空 = 复用主 LLM |
| `LLM_EMBEDDING_*` | embedding endpoint | 空 = 禁用语义检索 |
| `LLM_RERANK_*` | reranker endpoint | 空 = 禁用精排 |
| `LLM_RERANK_API_TYPE` | `cohere` 或 `tei` | cohere |
| `LLM_RERANK_ENABLED` | 显式开关（即使配 model 也能临时关） | true |
| `MANIM_QUALITY` | low / medium / high | low |
| `MANIM_USE_LATEX` | 是否启用 LaTeX | false |
| `DATA_DIR` | 数据目录（SQLite + 归档） | ./data |

---

## 📚 内置技能 + 可视化模式

**24+ 题型 skill**（`skills/definitions/visualization/*.md`）：
- 小学：addition / subtraction / multiplication / division / chicken_rabbit
- 初中：equation_basics / geometry
- 高中：quadratic_function
- 大学：limit_sinx_x
- 通用：comparison / continuous_operation / area_transform / travel_chasing / ...

**10 个通用可视化模式**（`skills/definitions/patterns/*.md`）——agent 自动匹配并把 helper 代码注入到 generate prompt 里：

| pattern | 用途 |
|---|---|
| counting | 数量计数（加减法、分组）|
| comparison | 数量比较（多/少多少、倍数）|
| process | 多步过程（先后顺序）|
| transformation | 一对一变换（鸡换兔）|
| assumption | **假设法专用**（鸡兔同笼）|
| table_method | 列表枚举法 |
| partition | 分割（分数、面积分解）|
| coordinate | 坐标系绘图（函数、点轨迹）|
| journey | 路径运动（相遇、追及）|
| derivation_with_geometry | 解方程逐步展开 + 几何同步（天平/面积/数轴）|

---

## 🛠️ 故障诊断

```bash
# LLM endpoint 通不通？哪个字段出问题？
python scripts/diagnose_lmstudio.py            # 完整请求
python scripts/diagnose_lmstudio.py --no-tools # 不带工具
python scripts/diagnose_lmstudio.py --tool analyze_problem
python scripts/diagnose_lmstudio.py --print-curl --dump-body /tmp/req.json
```

---

## 🛣️ 设计原则

1. **无固定流水线**：8 个工具，agent 自行决策调用顺序，阶段 A 并行
2. **跨工具记忆**：`ToolContext.state` 在工具间共享，agent 不必每次重复传上下文
3. **可追溯可复现**：每次对话、参数、结果、artifact 全落 SQLite + 文件系统
4. **反馈即数据**：good/bad 标记直接进 examples 库，下次自动 few-shot
5. **端点分层可配**：LLM / Vision / Embedding / Rerank 四个 endpoint 独立配置；任一缺失自动 fallback
6. **静态 prompt 外置**：5 个 markdown 模板可手编；动态上下文 render 时注入
7. **多模态视觉评审**：渲染后必经 inspect_video 兜底；发现重叠/对齐问题自动回去再生成

---

## 📄 License

MIT

## 🙏 致谢

- [Manim Community](https://www.manim.community/)
- DispatchMind — harness agent 蓝本
- [Claude Code](https://claude.com/claude-code) — 设计哲学参考
- [Anthropic Skills](https://github.com/anthropics/skills) — 技能系统参考
- [BGE](https://huggingface.co/BAAI) — 推荐的 embedding/reranker 模型
