# 🎬 讲解引擎（services/video-engine）

> 把一道数学题变成可播放的 Manim 教学动画（模式 B · 高级成片），
> 并为 Web 动态讲解（模式 A）产出 SceneSpec（plan-only）。
> 在 MathTutor 中作为黑盒服务运行，只暴露版本化 HTTP/SSE 契约；学生设备永不直连。

## ✨ 它能做什么

- 输入数学题 + 年级 → 五阶段有界工作流生成 720p30 教学动画
- 实时 SSE 推送每个工具调用、参数、结果（7 种事件类型）
- Solve/Verify 把模型结论编译为安全 Math IR，由 SymPy 独立计算、验算
- 可绘制的数学证据直接降低为 Visual IR；确定性编译器优先，不反复重写整份代码
- 渲染后结合确定性技术检测 + 多模态评审（质量门禁 v2 分级判定：good/acceptable/bad，不空手失败）
- `POST /api/v1/plan`：只跑 Solve→Verify→Direct，返回 SceneSpec 给 TS 侧 Web 播放器（无 ffmpeg 依赖）
- 每次会话、代码、视频全落 SQLite + 文件归档；反馈进入候选—复现—晋升学习流程

生成策略、质量门禁与调试复盘规范见
[数学视频生成策略与调试参考](../../docs/VIDEO_GENERATION_STRATEGIES.md)、
[Visual IR 设计](../../docs/VISUAL_SEMANTICS_DESIGN.md)。

## 🏗️ 架构

```
POST /api/v1/chat (SSE) ──► AgentLoop（有界状态机；正常路径零控制器 LLM 调用）
                              │
              ToolRegistry — 5 个产品阶段（严格按证据状态推进）：
                  • Solve    问题事实简报 + 结构化解答 + Math IR
                  • Verify   独立 Math IR / 逻辑 / 反例审计
                  • Direct   数学证据 → Visual IR；否则开放式 SceneSpec
                  • Compile  确定性 IR 编译优先 + 门禁 + 720p30 渲染
                  • Watch    抽帧 + 技术指标 + 数学/教学评审
                              │
              MathRuntime：白名单 AST → SymPy 精确运算 → claims 验证
              LearnedWiki：candidate 隔离 → 3 会话复现 → 晋升
              ConversationStore + FileArchive（SQLite + 文件系统）

POST /api/v1/plan ──► Solve → Verify → Direct → SceneSpec（不进 Compile/Watch）
GET  /api/v1/contract ──► 版本化契约（TS 网关启动时校验，不符拒绝启动）
```

生产链路不按题型路由：状态机只负责依赖和失败回退，LLM 把当前问题编译为紧凑的
数学与视觉中间表示，确定性运行时负责计算、验算、采样、布局与渲染。

## 📁 关键目录

```
services/video-engine/src/math_tutor/
├── api/routes/            # chat(SSE) / plan(SceneSpec) / contract / problems /
│                          # sessions / grades / health / videos
├── application/interfaces # ILLMProvider / ITool / ToolContext / ...
├── infrastructure/
│   ├── agent/
│   │   ├── loop.py            # 有界状态机 + SSE 事件
│   │   ├── math_runtime.py    # 安全 Math IR / SymPy 执行与函数采样
│   │   ├── prompt_templates/  # 11 个外置中文模板
│   │   ├── learned_wiki.py    # 候选/跨会话晋升
│   │   ├── quality_metrics.py # 内容无关质量指标
│   │   └── tools/             # 5 个产品阶段 + 可单测的内部编译组件
│   ├── llm/                   # OpenAI 兼容 provider（think 剥离/Hermes 回退）
│   ├── manim/                 # Manim 执行器
│   ├── media/                 # 字幕时间轴与可选 TTS 混流
│   └── storage/               # SQLite + 文件归档（sessions 表含 learner_id）
└── config/                    # settings + dependencies（路径锚定引擎根）
```

## 🚀 独立运行

```bash
# LMStudio 加载模型并启动 OpenAI 兼容服务（:1234；模型页关掉 Thinking toggle）
uv sync --extra dev
.venv/bin/python -m math_tutor.api.main        # :8000
```

`.env` 读取顺序：`services/video-engine/.env` → 仓库根 `.env`。
在 MathTutor 完整栈中由 TS 网关（apps/server）代理访问并注入 learner_id。

## 📡 API

```bash
# SSE 生成（推荐）
curl -N -X POST localhost:8000/api/v1/chat -H "Content-Type: application/json" \
  -d '{"problem":"鸡兔同笼，头35脚94","grade":"elementary_upper","learner_id":"..."}'
# 事件：session / text / reasoning / tool_call / tool_result / done / error

# plan-only（Web 讲解取 SceneSpec）
curl -X POST localhost:8000/api/v1/plan -H "Content-Type: application/json" \
  -d '{"problem":"长方形长8宽5，周长？","grade":"elementary_upper"}'

# 契约 / 会话 / 反馈
curl localhost:8000/api/v1/contract
curl localhost:8000/api/v1/sessions?learner_id=...
curl -X POST localhost:8000/api/v1/sessions/<id>/feedback \
  -H "Content-Type: application/json" -d '{"label":"good","notes":"假设法很清晰"}'
```

## ⚙️ 配置（.env）

| 变量 | 用途 | 默认 |
|---|---|---|
| `LLM_API_BASE/KEY/MODEL` | 主 LLM endpoint | LMStudio + qwen3.6-35b-a3b |
| `LLM_FAST_*` | 轻量任务端点（solve/verify/plan/ingest） | 空 = 回退主 LLM |
| `LLM_VISION_*` | 视觉模型（Watch 成片审查） | 空 = 复用主 LLM |
| `LLM_DISABLE_THINKING_WITH_TOOLS` | 工具调用时强制关思考 | true |
| `AGENT_DETERMINISTIC_WORKFLOW` | 有界状态机直接调度 | true |
| `LLM_EMBEDDING_*` / `LLM_RERANK_*` | 离线检索端点 | 空 = 禁用 |
| `MANIM_QUALITY` / `MANIM_USE_LATEX` / `MANIM_RENDER_TIMEOUT_S` | 渲染 | medium / false / 300 |
| `NARRATION_SUBTITLES_ENABLED` / `NARRATION_TTS_*` | 字幕 / 旁白 | true / 空 |
| `LEARNED_WIKI_ENABLED` | 候选—晋升学习 | false |
| `DATA_DIR` / `MANIM_OUTPUT_DIR` | 数据 / 媒体目录（相对路径锚定引擎根） | ./data / ./media |

## 🧠 反馈如何变成下次的提示

```
session 五阶段证据 + Watch 质量报告 + 用户反馈
  → ingester 只提炼与题目/题型无关的通用机制
  → candidates/ 隔离（生产不可检索）
  → 同一机制由至少 3 个独立 session 复现 → 晋升 lessons/
  → 仅在匹配具体运行错误时作为短 KB 片段检索
```

## 🛠️ 诊断与测试

```bash
python ../../scripts/diagnose_lmstudio.py            # LLM endpoint 排障
.venv/bin/python -m pytest -q tests                  # 238 个测试
```

## 🛣️ 设计原则

1. **有界而开放**：工作流依赖固定，数学内容和视觉方案开放；不枚举题型
2. **数学先执行后表达**：模型声明 Math IR，确定性工具计算与验算，视频只消费已验证证据
3. **可追溯可复现**：每次对话、参数、结果、artifact 全落 SQLite + 文件系统
4. **反馈是证据**：good/bad 反馈先隔离，跨会话复现后才晋升为生产知识
5. **紧凑阶段契约**：每个工具只接收当前阶段所需信息，大产物不回灌上下文
6. **双重成片门禁**：确定性技术检测 + 多模态数学/教学评审；重试只是有证据时的兜底

## 🙏 致谢

[Manim Community](https://www.manim.community/) · DispatchMind（harness agent 蓝本）·
[Claude Code](https://claude.com/claude-code)（设计哲学参考）·
[Anthropic Skills](https://github.com/anthropics/skills) · [BGE](https://huggingface.co/BAAI)
