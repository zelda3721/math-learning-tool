# 🎓 MathTutor · 数学成长引擎

> 一张会点亮的数学地图，一位不喂答案的导师，一台数形结合的讲解引擎。
>
> 不是为了考 100 分，而是知道如何考 100 分。

家庭本地部署的数学学习系统：孩子每天做少量精选题；做错了，系统沿知识图谱回溯真正薄弱的
前置知识，用揭示本质的动画讲透，再让他自己做对一道变式题来证明理解。日复一日，星图点亮、
错因模式消退、演化光路指向前沿。全部本地运行（LMStudio 等 OpenAI 兼容端点），平板可用。

由三个项目合并而成（math-wiki 进化树 × practise-diagnosis 蓝图 × math-learning-tool 视频引擎），
完整设计文档见项目 artifact「数学成长引擎 · 三工程合并设计」。**当前状态：P0–P5 全部落地。**

## 六条产品目标 → 落地形态

| 目标 | 形态 |
|---|---|
| 学科整体概念 | 星图进化树（75 节点 × 4 主线 × 4 学段）+ 演化光路 + 掌握度着色 |
| 知道自己的弱点 | 错因坐标归因（根因节点 + 误概念 + 置信度 + 依据链）+ 探针证据 + 错题本 |
| 直观理解 | 讲解双模式：**Web 动画默认**（SceneSpec 秒级逐拍播放，无 ffmpeg）/ Manim 视频高级（质量门禁 v2） |
| 解决问题的能力 | 提示阶梯 L1→L3 不喂答案 + 变式验证门（做对才点亮）+ SM-2 换题复习 |
| 融会贯通与研究 | 题型统一之路 + 苏格拉底探索对话 + 研究笔记（孩子自己的 wiki） |
| 知道如何考 100 分 | 学生「点亮地图 + 下一步」/ 家长「错因模式 + 趋势 + 判卷抽检 + 归因纠错」 |

## 教学法宪法（凌驾于一切功能之上）

1. **理解由行为验证，不由观看验证**——看完讲解必须做对同题型变式题，节点才点亮
2. **不喂答案**——答错先走提示阶梯自己再试；答案永不下发前端
3. **复习 = 同题型换题再练**——绝不重看原题答案式复习
4. **归因必须带证据**——错因是图谱坐标，附置信度与依据链；探针作答是证据，图遍历只是假设
5. **数形结合、揭示本质**——图形承担论证，文字关掉仍能看懂
6. **未核验的知识不承重**——节点 verified 或有实证才做根因归因；系统永不假装精准

## Monorepo 布局

```
mathtutor/
├─ packages/schema        # zod 单一类型真源：知识四实体 / 学习者 / SSE v2 / 引擎契约 / SceneSpec / 默认参数
├─ packages/knowledge     # 图算法（演化路径/归因候选回溯）、lint 不变量、离线定位器
├─ packages/llm-client    # OpenAI 兼容流式客户端（<think> 剥离 / Hermes 回退 / 五端点分层）
├─ packages/explainer-web # Web 动态讲解播放器：SceneSpec → SVG 逐拍渲染 + WAAPI（无 ffmpeg）
├─ apps/server            # Hono TS 单体：对外唯一入口（练习/诊断/讲解/探索/家长/录题 + 引擎代理 + 契约校验）
├─ apps/web               # React 七视图：练习(默认)/讲解/星图/错题本/探索/录题/家长
├─ services/video-engine  # Python 讲解引擎（黑盒，侵入四处封顶）→ services/video-engine/README.md
├─ data/knowledge/        # 知识层 file-first（graph.json / problems.json / questions/，git 版本化 + lint 闸门）
├─ data/                  # 运行时（app.sqlite / specs/ / notes/ / bench/，除 knowledge、bench 外不入 git）
└─ scripts/               # bench_video_throughput.py（产能实测）/ diagnose_lmstudio.py
```

## 🚀 快速开始

```bash
# 0) LMStudio 加载模型（如 qwen/qwen3.6-27b）并启动 OpenAI 兼容服务 :1234
#    仓库根 .env 是唯一配置文件（引擎与网关共读；真实环境变量优先级更高）：
#    LLM_API_BASE / LLM_MODEL / LLM_VISION_*（拍照判卷）· API_PORT（引擎，默认 8000）
#    SERVER_PORT（网关，默认 8080）· SERVER_HOST · ENGINE_URL · DATA_DIR

# 1) 安装与全量测试
pnpm install && pnpm -r build && pnpm -r test                  # TS：180 测试
cd services/video-engine && uv sync --extra dev \
  && .venv/bin/python -m pytest -q tests && cd ../..           # 引擎：238 测试

# 2) 三个进程
cd services/video-engine && .venv/bin/python -m math_tutor.api.main &   # 引擎 :8000（内网）
node apps/server/dist/index.js &                                        # 网关 :8080（对外唯一入口）
cd apps/web && VITE_API_PROXY=http://localhost:8080 npx vite            # 前端 :5173

# 平板：连同一局域网，访问 http://<电脑IP>:5173（或构建后由网关托管）
```

网关启动时会拉取引擎 `GET /api/v1/contract` 并用 zod 校验——版本不符**拒绝启动**而非静默失真；
开发时引擎未启动可用 `ALLOW_ENGINE_OFFLINE=1` 降级（讲解不可用，其余功能正常）。

> 本机若开系统代理，curl 调试本地端口需加 `--noproxy '*'`（引擎与 llm-client 已对本地地址绕代理）。

## 日常使用（七个视图）

- **练习**（默认）：选人 → 今日组卷（到期复习 > 探针 > 弱点 > 新题 + 1 挑战）→ 键盘/拍照作答 →
  判卷 → 提示阶梯 → 仍错则归因 → 看讲解（动画默认，可生成高级视频）→ 变式做对点亮
- **星图**：进化树 + 掌握度三档着色 + 演化光路 + 覆盖度面板 + 题型统一之路 + 节点核验
- **错题本**：根因 + 置信度 + 依据链，再看讲解 / 再练一道
- **探索**：苏格拉底对话（只引导不给答案）+「记下我的发现」研究笔记挂到图谱节点
- **录题**：粘贴 / 拍照 / PDF（单份或批量师生版配对）→ 抽题草稿 → 人工确认入库；抽检 tab 复核
- **家长**：错因模式聚合、14 天趋势、判卷抽检裁决（裁决后才计掌握度证据）、归因纠错
- **讲解**：直接给任意题目生成 Manim 教学视频（原引擎入口，含思考链观测台）

## 网关 API 速查（:8080，类型皆出自 packages/schema）

```
POST /api/v1/practice/today|submit|submit-photo|hint|variant     GET /api/v1/practice/next-step
POST /api/v1/diagnosis/{attemptId}          GET  /api/v1/diagnosis/mistakes
POST /api/v1/explain（默认 web 模式）        GET  /api/v1/explain/jobs/:id · /explain/specs/:id
POST /api/v1/explore/chat                   POST/GET /api/v1/notes
GET  /api/v1/parent/summary                 POST /api/v1/parent/verdict|correct-mistake
POST /api/v1/ingest/upload|batch|confirm|review                  GET /api/v1/ingest/jobs/:id|questions
GET  /api/v1/knowledge/coverage             POST /api/v1/knowledge/verify-node
GET  /api/v1/atlas · /api/v1/registry · /healthz                 （引擎 chat/sessions/media 经网关透传）
```

## 数据纪律

- **知识层 file-first**：`data/knowledge/` 里的图谱、题型、题目是 git 版本化 JSON，
  一切修改经 lint 闸门（悬挂/环/反向演化/去重），学习行为反哺只能生成候选变更集
- **学习者层 DB-first**：`data/app.sqlite`（learners/attempts/mastery/mistakes/review_cards/
  learner_events append-only）；掌握度是事件的可重放投影，固定参数启发式——永不宣称精准诊断
- **答案永不下发**：练习端点的题目 JSON 经 sanitize；家长抽检端点才含答案

## 测试与文档

```bash
pnpm -r test                                          # TS 180（schema/knowledge/llm-client/explainer-web/server）
services/video-engine/.venv/bin/python -m pytest -q services/video-engine/tests   # 引擎 238
```

- 引擎细节：`services/video-engine/README.md`
- 生成策略与质量门禁：`docs/VIDEO_GENERATION_STRATEGIES.md` · `docs/VISUAL_SEMANTICS_DESIGN.md`
- 产能基线：`data/bench/throughput-001.json`（qwen3.6-27b：中位 170s/条，一夜约 168 条）

## License

MIT
