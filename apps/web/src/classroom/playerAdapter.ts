/**
 * 把 `ExplainerPlayer` 包成课堂要的 `BeatPlayer` 端口。
 *
 * 这层薄适配是**唯一**知道"课堂用的是哪个播放器"的地方。
 * 课堂运行时（packages/classroom-runtime）只认 seekBeat/pause，
 * 所以换播放器实现、或某天换成一段视频，只需要改这一个文件。
 */
import type { ExplainerPlayer } from '@mathtutor/explainer-web'
import type { BeatPlayer, ClassroomEvent } from '@mathtutor/classroom-runtime'

export function createBeatPlayer(player: ExplainerPlayer): BeatPlayer {
    return {
        seekBeat: (index) => player.seekBeat(index),
        // 暂停要真的停：课堂结束时学生看到的应当定格，而不是自己往下走
        pause: () => player.pause(),
    }
}

/**
 * 播放器的拍切换 → 课堂事件。
 *
 * 播放器的 `onBeatChange` 在**切到新拍时**触发，正好对应状态机的 `beat-finished`
 * （上一拍讲完了）。返回一个可挂到 `onBeatChange` 上的回调。
 *
 * 单独用这一个回调是**不够**的，会和状态机形成回授（见 createClassroomBridge）。
 * 保留它只为实验台这类"手动驱动"的场合。
 */
export function beatChangeToEvent(
    dispatch: (event: ClassroomEvent) => void,
): (index: number, total: number) => void {
    return (index, total) => {
        // 第一拍是"开场"，不是"讲完了一拍"——把它也当成 beat-finished，
        // 课堂会立刻从第 0 拍跳到第 1 拍，孩子还没看见开场就过了一页
        if (index === 0) return
        // 播到最后一拍时也发一次：状态机据此进小结
        void total
        dispatch({ type: 'beat-finished' })
    }
}

/**
 * 课堂 ↔ 播放器的桥：状态机下发 seek、播放器回报"拍变了"，**并且挡住回授**。
 *
 * 回授长这样：状态机收到 `beat-finished` → 前进一拍 → 下发 `seekBeat` →
 * 播放器应用新帧时又同步回报 `onBeatChange` → 又被当成"讲完了" → ……
 * 实测（2026-11-06）：课堂里点一次「讲完了，继续」，画面直接从 1/7 跳到 7/7，
 * 提问那一拍永远等不到——**孩子点进课堂就再也做不上题**，页面上却没有任何报错。
 *
 * 判据不是时间，是"谁让它走的"：`seekBeat` 引起的拍变化是**我们自己下发的指令**，
 * 一律静音；只有播放器自己往前播（将来接了 TTS）才算讲完了一拍。
 *
 * 只记"最近一次下发的拍号"，不排队：播放器不保证每次 seek 都回报一次
 * （构造时那次就不回报），排队的记录会和真实回报错位，回授照旧发生
 * ——实测排队版仍然从 1/7 连锁到 7/7。
 */
export function createClassroomBridge(
    player: Pick<ExplainerPlayer, 'seekBeat' | 'pause'>,
    dispatch: (event: ClassroomEvent) => void,
): { beatPlayer: BeatPlayer; onBeatChange: (index: number, total: number) => void } {
    let lastSeek: number | null = null
    return {
        beatPlayer: {
            seekBeat: (index) => {
                lastSeek = index
                player.seekBeat(index)
            },
            pause: () => player.pause(),
        },
        onBeatChange: (index) => {
            // 落在我们自己下发的那个拍上：这是指令的回声，不是"讲完了"
            if (lastSeek !== null && index === lastSeek) {
                lastSeek = null
                return
            }
            if (index === 0) return
            dispatch({ type: 'beat-finished' })
        },
    }
}
