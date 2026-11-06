/**
 * 实验台在 window 上挂的口子。**只在这里声明一次**——
 * 每个 spec 各写一份 `declare global` 会互相冲突（TS 要求同名属性类型一致），
 * 而它们本来就是同一批页面上的同一批钩子。
 */
export {}

declare global {
  interface Window {
    __playerLab?: {
      seek(tMs: number): void
      duration(): number
      beats(): number
      svg(): string
      classroom: {
        start(): string
        beatFinished(): string
        pauseQuestion(q: string): string
        resume(): string
        beatIndex(): number
        svg(): string
      }
    }
    __mathLab?: { atoms(): number; seek(local: number): number; width(): number }
  }
}
