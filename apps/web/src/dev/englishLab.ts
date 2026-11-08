/**
 * 英语画面实验台（仅冒烟测试用）。
 *
 * 为什么需要它：`sentence` / `card` 这两种形状的纯逻辑（切分高亮区间、算字号、排版）
 * 都在 node 里测过了，但"真的画进 SVG"这一层只能在真浏览器里验。
 * 这一层断了，孩子看到的是一节空白的课，而页面上不会有任何报错。
 *
 * 暴露给测试的口子刻意很小：seek、时长、当前 SVG 的序列化。
 */
import { ExplainerPlayer, type SceneSpec } from '@mathtutor/explainer-web'
import { renderMathAtoms } from '../math/katexAtoms'

/**
 * 一句教材例句 + 一张词卡。
 *
 * 例句里刻意带**弯撇号**：教材原句就是 `She’s`，渲染时不能被"整理"成直撇号。
 * 高亮只框 `eating`——它在句子里真实存在，也正是这一课要练的动词形式。
 */
const SPEC = {
    visual_objects: [
        {
            id: 's1',
            primitive: 'en.sentence_highlight',
            params: { text: 'She’s eating an apple.', highlight: 'eating' },
        },
        { id: 'c1', primitive: 'en.vocab_card', params: { term: 'half past eight', meaning: '八点半' } },
    ],
    scenes: [
        { actions: [{ op: 'appear', target: 's1' }], teaching_line: '看这一句' },
        { actions: [{ op: 'appear', target: 'c1' }], teaching_line: '顺便记住这个说法' },
    ],
} as unknown as SceneSpec

const stage = document.getElementById('stage')
if (!stage) throw new Error('实验台缺少 #stage')

const player = new ExplainerPlayer(stage, SPEC, {
    controls: false,
    autoPlay: false,
    transitionMs: 420,
    math: renderMathAtoms,
})

interface EnglishLabHandle {
    seek(tMs: number): void
    duration(): number
    svg(): string
}

declare global {
    interface Window {
        __englishLab?: EnglishLabHandle
    }
}

window.__englishLab = {
    seek: (tMs: number) => player.seek(tMs),
    duration: () => player.duration,
    svg: () => stage.querySelector('svg')?.outerHTML ?? '',
}
