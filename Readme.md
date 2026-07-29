# 🎓 AI Math Tutor

> 把一道数学题变成可播放的 Manim 教学动画。
> 架构借鉴 Claude Code / DispatchMind 的 harness agent 思想，使用本地 LLM（默认 LMStudio + Qwen3.6），全链路对话与代码本地持久化，支持人类反馈闭环。

---

## ✨ 它能做什么

- 输入数学题 + 选年级 → 生成 Manim 解题动画
- 实时显示生成流水线：每个工具调用、参数、结果都通过 SSE 推到前端
- 每次对话、生成的代码、最终视频都本地落库（SQLite + 文件系统）
- 你可以对每次结果打 👍/👎；反馈会进入候选—复现—晋升学习流程
- 不枚举题型、不向生产提示词注入相似题代码；视觉方案由当前数学语义生成
- 渲染后结合确定性技术检测和多模态模型评审；有问题自动局部修复或重做视觉 beat
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
│  ToolRegistry — 8 个生产工具（严格按证据状态推进）：           │
│    阶段 A — 语义与数学正确性                                   │
│      • analyze_problem       对象/关系/约束开放式分解          │
│      • solve_problem         结构化解答                        │
│      • verify_solution       可执行校验或逻辑/反例审计         │
│    阶段 B — 开放式视觉论证                                     │
│      • visual_plan           thesis/符号账本/时间 beat         │
│    阶段 C — 生成与校验                                         │
│      • generate_manim_code   生成/修复 Manim 代码              │
│      • validate_manim_code   静态语法+质量+重叠检测            │
│    阶段 D — 串行执行与视觉评审                                 │
│      • run_manim             720p30 + WebVTT/可选 TTS + 缓存  │
│      • inspect_video         5 帧+技术指标+数学契约评审        │
├──────────────────────────────────────────────────────────────┤
│  LearnedWiki：candidate 隔离 → 3 个独立 session 复现 → 晋升    │
│  QualityReport：首轮成功/数学一致性/技术门禁/耗时/重试          │
│  ConversationStore + FileArchive (SQLite + 文件系统)           │
└──────────────────────────────────────────────────────────────┘
```

生产链路不按题型路由。状态机只负责依赖和失败回退，LLM 分别负责当前问题的语义、解答、
视觉论证与代码；大段代码保存在 state/artifact 中，不回灌控制器上下文。

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
│   │   │   ├── markdown_extract.py # markdown→结构化数据
│   │   │   ├── learned_wiki.py    # 候选/跨会话晋升
│   │   │   ├── quality_metrics.py # 内容无关质量指标
│   │   │   ├── tool_registry.py
│   │   │   └── tools/             # 8 个工具
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
PromptLibrary loaded 8 templates: ['analyze', 'generate_manim', 'inspect_video', 'match_skill_llm', 'solve', 'verify_solution', 'visual_plan', 'wiki_ingest']
OpenAILLMProvider ready (base_url=..., model=qwen/qwen3.6-35b-a3b, bypass_proxy=True)
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
session 工具证据 + inspect_video 质量报告 + 用户反馈
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
| `LLM_VISION_*` | 视觉模型 endpoint（inspect_video 用） | 空 = 复用主 LLM |
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
python scripts/diagnose_lmstudio.py --tool analyze_problem
python scripts/diagnose_lmstudio.py --print-curl --dump-body /tmp/req.json
```

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

---

## 📄 License

MIT

## 🙏 致谢

- [Manim Community](https://www.manim.community/)
- DispatchMind — harness agent 蓝本
- [Claude Code](https://claude.com/claude-code) — 设计哲学参考
- [Anthropic Skills](https://github.com/anthropics/skills) — 技能系统参考
- [BGE](https://huggingface.co/BAAI) — 推荐的 embedding/reranker 模型
