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
