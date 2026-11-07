import { describe, expect, it } from 'vitest'
import { createClassroomBridge } from './playerAdapter'

/**
 * 课堂 ↔ 播放器桥：**必须挡住回授**。
 *
 * 这一段曾经坏过，而且坏得没有任何报错：状态机收到 beat-finished 就前进一拍 →
 * 下发 seekBeat → 播放器应用新帧时同步回报 onBeatChange → 又被当成"讲完了"……
 * 实测点一次「讲完了，继续」，画面从 1/9 直接跳到 9/9，提问那一拍永远等不到——
 * 孩子点进课堂就再也做不上题。
 */

describe('createClassroomBridge', () => {
    it('自己下发的 seek 不算"讲完了"：点一次只前进一拍，不会连锁到最后一拍', () => {
        const events: string[] = []
        let beat = 0
        // 真播放器在 seekBeat 里同步重绘并回报拍变化，这里照样复现
        let bridge!: ReturnType<typeof createClassroomBridge>
        const fake = {
            seekBeat: (i: number) => {
                beat = i
                bridge.onBeatChange(i, 9)
            },
            pause: () => {},
        }
        // 模拟状态机的接线：听到 beat-finished 就前进一拍并下发 seek
        bridge = createClassroomBridge(fake, (event) => {
            events.push(event.type)
            if (event.type !== 'beat-finished') return
            beat += 1
            bridge.beatPlayer.seekBeat(beat)
        })

        // 孩子点了一次「讲完了，继续」
        bridge.onBeatChange(1, 9)

        expect(beat).toBe(1)
        expect(events.filter((t) => t === 'beat-finished')).toHaveLength(1)
    })

    it('播放器自己往前播（不是我们下发的）才算讲完一拍', () => {
        const events: string[] = []
        const bridge = createClassroomBridge({ seekBeat: () => {}, pause: () => {} }, (e) =>
            events.push(e.type),
        )
        // 先下发过一拍（被回报消费掉），再自己往前播：后者要算数
        bridge.beatPlayer.seekBeat(3)
        bridge.onBeatChange(3, 9)
        bridge.onBeatChange(4, 9)
        expect(events).toEqual(['beat-finished'])
    })

    it('第 0 拍是开场，不算讲完了一拍', () => {
        const events: string[] = []
        const bridge = createClassroomBridge({ seekBeat: () => {}, pause: () => {} }, (e) =>
            events.push(e.type),
        )
        bridge.onBeatChange(0, 5)
        expect(events).toEqual([])
    })
})
