/**
 * 播放器实验台（仅冒烟测试用）。
 *
 * 为什么需要它：`ExplainerPlayer` 的纯逻辑（时间轴、补间、布局）都在 node 里测过了，
 * 但"把位置画进 SVG"这一层只能在真浏览器里验。没有这个页面，
 * "同一时刻 t 的渲染逐像素一致"就只是一句推理，谁也不知道它在 DOM 上到底成不成立。
 *
 * 暴露给测试的口子刻意很小：seek、duration、当前 SVG 的序列化。
 * 比的是标记字符串而不是截图——SVG 属性都是显式写死的，同样的输入必得同样的字符串；
 * 这比截图稳（不受字体/DPI/抗锯齿影响），也更说明问题（diff 直接指向挪了的那个元素）。
 */
import { ExplainerPlayer, type SceneSpec } from '@mathtutor/explainer-web'

/**
 * 同一个场景里放两条补间路径，缺一不可：
 * - `unit_grid`：展开成**可数记号**，每个单位单独定位（跨组搬运靠位置插值）
 * - `quantity_bar`：画成一根"条"，量由 set_value 改（靠几何插值）
 *
 * 两条路径的布局分支不同，一个测到了不代表另一个也对。而且条的量只能由 set_value 改——
 * 早先没有这个动作时，条在相邻两拍之间恒定不变，测出来"什么都没动"，
 * 很容易被误判成"补间没生效"。
 */
const SPEC = {
    visual_objects: [
        { id: 'apples', primitive: 'unit_grid', params: { total: 12 } },
        { id: 'basket', primitive: 'unit_grid', params: { total: 0 } },
        { id: 'price', primitive: 'quantity_bar', params: { total: 12 } },
    ],
    scenes: [
        {
            actions: [
                { op: 'appear', target: 'apples' },
                { op: 'appear', target: 'price' },
            ],
            teaching_line: '篮子里有 12 个苹果',
        },
        {
            actions: [
                { op: 'take_from', source: 'apples', destination: 'basket', count: 4 },
                { op: 'set_value', target: 'price', value: 8 },
            ],
            teaching_line: '拿走 4 个',
        },
        {
            actions: [
                { op: 'take_from', source: 'apples', destination: 'basket', count: 3 },
                { op: 'set_value', target: 'price', value: 5 },
            ],
            teaching_line: '再拿走 3 个',
        },
    ],
} as unknown as SceneSpec

const stage = document.getElementById('stage')
if (!stage) throw new Error('实验台缺少 #stage')

const player = new ExplainerPlayer(stage, SPEC, {
    controls: false,
    autoPlay: false,
    // 固定转场时长，测试才能算准"转场窗口是 [2780, 3200)"
    transitionMs: 420,
})

interface LabHandle {
    seek(tMs: number): void
    duration(): number
    svg(): string
    beats(): number
}

declare global {
    interface Window {
        __playerLab?: LabHandle
    }
}

window.__playerLab = {
    seek: (tMs: number) => player.seek(tMs),
    duration: () => player.duration,
    beats: () => player.beatCount,
    svg: () => stage.querySelector('svg')?.outerHTML ?? '',
}
