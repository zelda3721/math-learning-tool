import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Button, MathText } from '../ui'
import { submitAnswer } from '../practice/api'
import type { WidgetQuestion } from './api'

/** 判分只有四种结局；'correct-unverified' 是"对了但依据只有 AI"，文案不能混同 */
type Feedback = 'correct' | 'correct-unverified' | 'review' | 'wrong' | null

/**
 * 收尾题：动手玩完之后，用一道变式题把"看懂了"变成证据。
 *
 * 为什么判分只发生在这里、不在组件里：组件回答的是"它为什么会这样"，
 * 摸到边界就是收获，给它打分只会让孩子去猜分数想要什么。
 * 这一题走的是正常判卷（/practice/submit，source=explore），所以掌握度、
 * 证据等级、家长抽检那一整串照旧生效——动手的痕迹则另走 /widgets/trace。
 *
 * 三态文案照练习页的既有口径：ai_unverified 必须标注"未计入掌握度"，
 * 否则孩子会以为星星亮了，其实没亮。
 *
 * 换题靠调用方传 key 重新挂载（而不是在这里监听 questionId 去 setState）：
 * 在 effect 里同步重置状态会多渲染一轮，也容易和判卷的异步回调抢时序。
 */
export function WidgetFollowUp({
  question,
  learnerId,
  onFinished,
}: {
  question: WidgetQuestion
  learnerId: string
  onFinished?: () => void
}) {
  const [answer, setAnswer] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [feedback, setFeedback] = useState<Feedback>(null)
  const [error, setError] = useState<string | null>(null)
  /** 计时起点：在 effect 里取，不放进渲染路径（渲染必须是纯的） */
  const startRef = useRef(0)
  useEffect(() => {
    startRef.current = performance.now()
  }, [])

  const finished = feedback === 'correct' || feedback === 'correct-unverified' || feedback === 'review'

  const submit = async () => {
    const trimmed = answer.trim()
    if (!trimmed || submitting || finished) return
    setSubmitting(true)
    setError(null)
    try {
      const startedAt = startRef.current || performance.now()
      const result = await submitAnswer({
        learnerId,
        questionId: question.questionId,
        answer: trimmed,
        // 探索里没有提示链，如实报 0——虚报会把"独立做对"的分量算轻
        hintLevelUsed: 0,
        durationS: Math.round((performance.now() - startedAt) / 100) / 10,
        source: 'explore',
      })
      if (result.needsReview) setFeedback('review')
      else if (result.correct) {
        setFeedback(result.verification === 'ai_unverified' ? 'correct-unverified' : 'correct')
      } else setFeedback('wrong')
      onFinished?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <div className="space-y-3">
      <p className="eyebrow">收尾题 · 动手不算分，这道题算</p>
      <p className="stem">
        <MathText>{question.stem}</MathText>
      </p>

      {question.options && question.options.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {question.options.map((option) => (
            <Button
              key={option}
              variant={answer === option ? 'primary' : 'secondary'}
              disabled={finished || submitting}
              onClick={() => setAnswer(option)}
              className="text-left"
            >
              {option}
            </Button>
          ))}
        </div>
      ) : (
        <input
          value={answer}
          disabled={finished}
          onChange={(e) => setAnswer(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="在这里写答案，按回车提交"
          className="input-hero disabled:bg-paper disabled:text-ink-faint"
        />
      )}

      {feedback === 'correct' && (
        <div className="rounded-[10px] bg-correct-wash border border-correct/25 px-4 py-3 text-[var(--color-correct)] font-semibold">
          答对啦！刚才动手看到的那条关系，你用上了。
        </div>
      )}
      {feedback === 'correct-unverified' && (
        <div className="rounded-[10px] bg-paper border border-rule px-4 py-3 text-ink-soft font-medium">
          答对了。不过这次是 AI 判断、尚未验证，所以先不算进掌握度——
          再用老师教的方法答一遍，这颗星才是真的亮了。
        </div>
      )}
      {feedback === 'review' && (
        <div className="rounded-[10px] bg-paper border border-rule px-4 py-3 text-ink-soft font-medium">
          这道题已交给家长确认，先放下吧。
        </div>
      )}
      {feedback === 'wrong' && (
        <div className="rounded-[10px] bg-wrong-wash border border-wrong/25 px-4 py-3 text-wrong font-semibold">
          还不太对。回到上面的组件再拨一拨，看看关系是什么，然后改一改答案再交。
        </div>
      )}
      {error && (
        <div className="rounded-[10px] bg-wrong-wash border border-wrong/25 px-4 py-3 text-wrong text-sm">
          出了点小问题：{error}，请再试一次。
        </div>
      )}

      {!finished && (
        <Button onClick={() => void submit()} disabled={!answer.trim() || submitting}>
          {submitting ? '批改中……' : feedback === 'wrong' ? '再交一次' : '交卷'}
        </Button>
      )}
    </div>
  )
}
