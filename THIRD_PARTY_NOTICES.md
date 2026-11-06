# 第三方代码声明（THIRD_PARTY_NOTICES）

本项目包含或改编了下列第三方开源代码。逐条登记；新增移植时同步更新本文件，
并在对应源文件头部保留来源注释。

---

## OpenMAIC

- 上游：OpenMAIC v1.4.0，提交 `795420c1`
- 地址：https://github.com/THU-MAIC/OpenMAIC
- 许可：MIT
- 用途：AI 课堂的播放/动作引擎、可交互场景宿主、生成工具链（json-repair / 重试 / 后处理 / 脚本校验）。
  移植清单与验收标准见 `docs/OPENMAIC_PORT.md`。
- 状态：**已开始移植**。已移入 `packages/classroom-runtime/src/`：
  `types.ts`、`derived-state.ts`、`auto-resume.ts`、`action-navigation.ts`、`action-resume.ts`
  （上游 `lib/playback/` 的纯逻辑部分），以及改写后的 `action.ts`。
  每个文件头都写着 `Adapted from OpenMAIC <path> @795420c1 (MIT)`。
- 改写说明：上游的 Action 契约来自 `@openmaic/dsl`（9,329 行）。这里**不搬那套契约**，
  只保留被搬算法实际用到的 `id`/`type` 两个字段（见 `action.ts` 的说明）。
- 上游 LICENSE 全文：`THIRD_PARTY_NOTICES/openmaic-LICENSE.txt`。
- 不采用的部分：`@openmaic/renderer`、agent-runtime / pbl-v3、importer、
  `mathml2omml`（LGPL）、GSAP / Hyperframes、云端媒体 provider。

MIT 许可要求保留版权与许可声明；上游 LICENSE 全文在移植时一并收录到
`THIRD_PARTY_NOTICES/openmaic-LICENSE.txt`。
