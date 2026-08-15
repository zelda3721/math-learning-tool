/**
 * 「拍题识别」按钮：选照片/拍照 → 识别出题干与题干配图 → 回调给页面。
 * 问一道题与讲解两处共用；识别结果一律回填输入框让人过目，绝不直接提交。
 */
import { useRef, useState } from 'react'
import { Button, type ButtonSize } from '../ui'
import { extractPhotoProblem, photoToDataUrl, type ExtractedPhotoProblem } from './photoProblem'

interface PhotoProblemButtonProps {
    /** 识别时的年级提示（影响服务端抽取的学段判断） */
    level?: string
    disabled?: boolean
    size?: ButtonSize
    onExtracted: (result: ExtractedPhotoProblem) => void
    onError: (message: string) => void
}

export function PhotoProblemButton({ level, disabled, size = 'lg', onExtracted, onError }: PhotoProblemButtonProps) {
    const inputRef = useRef<HTMLInputElement>(null)
    const [busy, setBusy] = useState(false)

    const handleFile = async (file: File) => {
        setBusy(true)
        try {
            const photo = await photoToDataUrl(file)
            onExtracted(await extractPhotoProblem(photo, level))
        } catch (err) {
            onError(err instanceof Error ? err.message : String(err))
        } finally {
            setBusy(false)
        }
    }

    return (
        <>
            {/* 不加 capture：手机上让系统弹「拍照还是相册」，两条路都留着 */}
            <input
                ref={inputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                    const file = e.target.files?.[0]
                    // 立刻清掉：同一张照片重选一次也要能再触发
                    e.target.value = ''
                    if (file) void handleFile(file)
                }}
            />
            <Button
                type="button"
                variant="secondary"
                size={size}
                disabled={disabled || busy}
                onClick={() => inputRef.current?.click()}
            >
                {busy ? '识别中……' : '📷 拍题识别'}
            </Button>
        </>
    )
}
