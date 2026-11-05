import type { SubjectPackage, VerifierDef, VisualVocabEntry } from "@mathtutor/core";
import { ITEM_TYPES, JUDGES } from "./judges.js";

/**
 * 英语学科包（骨架）。
 *
 * 存在的意义：证明**不修改内核**也能接入一门新学科——题型、判卷器、验证器、
 * 视觉词汇都由这里提供，内核只通过 `SubjectPackage` 接口认识它。
 *
 * 骨架里刻意没有的东西（阶段 5 才做）：
 * 语音（ASR/TTS）、口语对练、写作量规、分级读物、SM-2 词表调度。
 * 现在放进来只会是空壳，而空壳会让人以为能力已经有了。
 */

/** 验证器：英语没有可执行验算，只有"答案有出处"这一种 */
const VERIFIERS: VerifierDef[] = [
  { id: "en.reference", subject: "en", kind: "reference" },
];

/**
 * 视觉词汇：英语课堂表达力主要靠卡片与图文，不靠坐标系。
 * 命名空间统一 `en.*`，播放器据此找渲染器（数学的图元不带前缀，见 SceneSpec）。
 */
const VISUALS: VisualVocabEntry[] = [
  { primitive: "en.vocab_card", subject: "en" },
  { primitive: "en.sentence_highlight", subject: "en" },
];

export const englishSubject: SubjectPackage = {
  id: "en",
  name: "英语",
  itemTypes: ITEM_TYPES,
  judges: JUDGES,
  verifiers: VERIFIERS,
  visuals: VISUALS,
};

export * from "./judges.js";
