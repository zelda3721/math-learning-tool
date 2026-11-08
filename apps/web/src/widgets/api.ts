/**
 * 交互组件的两条服务端接口（契约见 apps/server/src/routes/widgets.ts）。
 *
 * 两件事都不"挡路"：
 * - 拉组件（for-node）失败 → 返回 null，探索页就当这个知识点没有动手环节；
 *   探索页的主线是跟伙伴聊天，不能因为一个可选的组件挂掉就整页变红。
 * - 记一次探索（trace）失败 → 抛给调用方，调用方**静默吞掉**：
 *   孩子已经看到了收尾题，不能因为"日志没写进去"就把题收走。
 */
import type { WidgetAction, WidgetSpec, WidgetState } from '@mathtutor/widgets'

/** 服务端只给做题必需的那几项（不含答案），见 classroom/lesson.ts 的 toLessonQuestion */
export interface WidgetQuestion {
  questionId: string
  stem: string
  answerType: string
  options: string[] | null
  difficulty: number
  nodeIds: string[]
}

export interface WidgetForNode {
  widget: WidgetSpec | null
  question: WidgetQuestion | null
  note: string
}

/** best-effort：拿不到就返回 null（没有组件就不显示这张卡，而不是显示一张空白卡） */
export async function fetchWidgetForNode(nodeId: string): Promise<WidgetForNode | null> {
  try {
    const res = await fetch(`/api/v1/widgets/for-node?nodeId=${encodeURIComponent(nodeId)}`)
    if (!res.ok) return null
    const body = (await res.json()) as Partial<WidgetForNode>
    return {
      widget: body.widget ?? null,
      question: body.question ?? null,
      note: body.note ?? '',
    }
  } catch {
    return null
  }
}

export interface WidgetTracePayload {
  learnerId: string
  nodeId: string
  widget: string
  actions: WidgetAction[]
  finalState: WidgetState
}

/**
 * 记一次探索。服务端会用 replayWidget 重放一遍操作、以重放结果为准，
 * 所以这里如实上报操作序列即可——它不采信客户端自己报的 finalState。
 */
export async function postWidgetTrace(payload: WidgetTracePayload): Promise<void> {
  const res = await fetch('/api/v1/widgets/trace', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}
