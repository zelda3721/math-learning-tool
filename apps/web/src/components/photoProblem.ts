/**
 * 拍照识题（问一道题 / 讲解共用）。
 *
 * 复用录题管线的分层抽取，但目标不同：录题面对整本讲义，这里面对
 * 孩子拍的**一道题**。流程仍是三步——照片切题（服务端）→ 按框裁图（本地
 * 画布）→ 单题识别（服务端）——因为服务端没有画布，裁图只能在前端做。
 *
 * 抽出来的题干一律回填到输入框让孩子过目再提交：模型读错一个数字，
 * 后面判卷、讲解全都跟着错，这一眼人工确认省不掉。
 */
import { cropPage, figureCropBox, type Box } from '../ingest/crop'
import { extractErrorMessage, readFileAsDataUrl } from '../ingest/shared'

/** 服务端 /ask/photo/layout 返回的一条（classifyFigures 已判好题干图/解析图） */
export interface PhotoLayoutItem {
    index: number
    label: string
    preview: string
    box?: Box
    hasFigure: boolean
    stemFigureBox?: Box
    analysisFigureBox?: Box
    continued?: boolean
    dangling?: boolean
    answerTop?: number
}

export interface ExtractedPhotoProblem {
    problem: string
    /** 题干配图（从照片上裁下的 data URL）；没图的题就没有 */
    figureImage?: string
}

/**
 * 手机原图动辄 4000×3000、好几 MB：直接发给本地视觉模型既慢又没必要
 * （讲义页在录题管线里也就渲染到这个量级）。超过就等比缩到最长边 1600。
 */
const MAX_SIDE = 1600
const JPEG_QUALITY = 0.85

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = () => reject(new Error('这张图片打不开，换一张试试（截图或 JPG/PNG 都可以）'))
        img.src = dataUrl
    })
}

/**
 * 照片 → 送识别的 data URL：统一缩尺寸、统一转 JPEG（顺带把 HEIC 之类挡在早期）。
 * 带 EXIF 方向的照片浏览器解码时会自动转正，经画布重编码后就是正的；
 * 但微信传的图 EXIF 被剥光、像素本身是横的——那种靠后面的方向判定趟。
 */
export async function photoToDataUrl(file: File): Promise<string> {
    const raw = await readFileAsDataUrl(file)
    const img = await loadImage(raw)
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight))
    const width = Math.max(1, Math.round(img.naturalWidth * scale))
    const height = Math.max(1, Math.round(img.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return raw
    // 透明底在 JPEG 里会变黑（截图常见）——先铺白
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(img, 0, 0, width, height)
    const out = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
    canvas.width = 0
    canvas.height = 0
    return out
}

/** 把图顺时针旋转 90/180/270 度（0 度原样返回）。转不动时原样返回，不拦流程。 */
export async function rotateDataUrl(dataUrl: string, cwDegrees: number): Promise<string> {
    const norm = ((Math.round(cwDegrees / 90) * 90) % 360 + 360) % 360
    if (norm === 0) return dataUrl
    const img = await loadImage(dataUrl)
    const swap = norm === 90 || norm === 270
    const canvas = document.createElement('canvas')
    canvas.width = swap ? img.naturalHeight : img.naturalWidth
    canvas.height = swap ? img.naturalWidth : img.naturalHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return dataUrl
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    // canvas 的 y 轴朝下，正角就是顺时针——与服务端「顺时针转 n 度」的约定一致
    ctx.translate(canvas.width / 2, canvas.height / 2)
    ctx.rotate((norm * Math.PI) / 180)
    ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2)
    const out = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
    canvas.width = 0
    canvas.height = 0
    return out
}

const boxArea = (box?: Box): number => (box ? Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]) : 0)

/**
 * 照片里认出多道题时选哪道：**占面积最大的那道**。
 * 孩子拍的是自己不会的那道题，取景自然以它为主体；就算选错了，
 * 题干会回填到输入框里给人看，改一下就是。光杆题号（dangling）不参选。
 */
export function pickPhotoItem<T extends PhotoLayoutItem>(items: T[]): T | null {
    const candidates = items.filter((item) => !item.dangling)
    if (candidates.length === 0) return null
    const withBox = candidates.filter((item) => item.box)
    if (withBox.length === 0) return candidates[0]!
    return withBox.reduce((best, item) => (boxArea(item.box) > boxArea(best.box) ? item : best))
}

async function post(path: string, body: unknown, notReadyHint: string): Promise<Response> {
    const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(await extractErrorMessage(res, notReadyHint))
    return res
}

const NOT_READY = '拍照识题还没配置好——先把题目打字输入吧'

/**
 * 照片的裁图余量比 PDF 版面（0.8%）大得多：手持拍摄本来就歪斜松散，
 * 模型的框也更毛糙——实机上一道几何题的框顶边偏低 5%，顶点 D、E 的标签
 * 被齐齐裁掉，图对几何题就废了。照片上一题占满画面，放大余量不会蹭到邻题。
 */
const PHOTO_PAD = 0.05
const PHOTO_ITEM_PAD = { padX: PHOTO_PAD, padY: PHOTO_PAD }

/**
 * 题干配图的裁框：上/左/右放大 PHOTO_PAD 救回被模型框裁掉的顶点标签，
 * **下边绝不越过答案线**。服务端 classifyFigures 特意把题干图框钳到 answerTop
 * （实机事故：裁出的配图底部印着「【答案】92」），余量要是把这一刀又扩回去，
 * 答案就从图片面漏给孩子了——文本面守得再严也白搭。
 */
export function figurePadBox(box: Box, answerTop?: number): Box {
    const bottomLimit = typeof answerTop === 'number' ? Math.min(1, Math.max(box[3], answerTop)) : 1
    return [
        Math.max(0, box[0] - PHOTO_PAD),
        Math.max(0, box[1] - PHOTO_PAD),
        Math.min(1, box[2] + PHOTO_PAD),
        Math.min(bottomLimit, box[3] + PHOTO_PAD),
    ]
}

/** 方向判定的时限：锦上添花的一步，模型挂起时不许把整条链路拖死 */
const ORIENTATION_TIMEOUT_MS = 15_000

/**
 * 第 0 步：问服务端「这张照片顺时针转多少度文字才正」，需要就本地转正。
 * 这一步是锦上添花——判定失败/超时/端点不支持时按原样继续，绝不拦整条链路。
 */
async function uprightPhoto(photoDataUrl: string): Promise<string> {
    try {
        const res = await fetch('/api/v1/ask/photo/orientation', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ content: photoDataUrl }),
            signal: AbortSignal.timeout(ORIENTATION_TIMEOUT_MS),
        })
        if (!res.ok) return photoDataUrl
        const { rotate } = (await res.json()) as { rotate?: number }
        if (!rotate) return photoDataUrl
        return await rotateDataUrl(photoDataUrl, rotate)
    } catch {
        return photoDataUrl
    }
}

async function layoutItems(photoDataUrl: string): Promise<PhotoLayoutItem[]> {
    const res = await post('/api/v1/ask/photo/layout', { content: photoDataUrl }, NOT_READY)
    const { items = [] } = (await res.json()) as { items?: PhotoLayoutItem[] }
    return items
}

/** 整条链路：照片 → 转正 → 题干文本 + 题干配图。任何一步失败都抛可读的错。 */
export async function extractPhotoProblem(
    rawPhotoDataUrl: string,
    level?: string,
): Promise<ExtractedPhotoProblem> {
    // 侧着拍的照片先转正：版面框、题干/解析分界、裁图全都按文字水平来判
    let photoDataUrl = await uprightPhoto(rawPhotoDataUrl)
    let items = await layoutItems(photoDataUrl)
    let item = pickPhotoItem(items)
    /**
     * 方向判错的自救：模型偶尔在 90/270 之间摇摆，判反了照片就是倒的，
     * 版面自然一无所获。这时退回**未旋转的原图**再试一次——否则用户看到的
     * 是「光线好一点再拍」这种与真因无关的提示，照着做还会确定性复现。
     */
    if (!item && photoDataUrl !== rawPhotoDataUrl) {
        photoDataUrl = rawPhotoDataUrl
        items = await layoutItems(photoDataUrl)
        item = pickPhotoItem(items)
    }
    if (!item) throw new Error('照片里没认出题目——光线好一点、把整道题拍全再试试')

    /**
     * 照片里就认出一道题时**不按框裁**，整张照片直接送识别。
     * 实机教训：版面框顶边低了一行，题干开头「已知四边形ABCD中…面积为12」
     * 被齐齐裁掉，模型只好拿手写笔迹重构条件——抽出来的题缺条件还看不出毛病。
     * 单题照片没有"邻题干扰"要切，裁只有风险没有收益；多道题才按框裁（大余量）。
     */
    const multipleItems = items.filter((i) => !i.dangling).length > 1
    const cropped = multipleItems
        ? ((await cropPage(photoDataUrl, item.box, PHOTO_ITEM_PAD).catch(() => null)) ?? photoDataUrl)
        : photoDataUrl
    const questionRes = await post('/api/v1/ask/photo/question', { content: cropped, level }, NOT_READY)
    const { stem } = (await questionRes.json()) as { stem?: string | null }
    if (!stem?.trim()) throw new Error('照片里没读出题目——光线好一点、把整道题拍全再试试')

    // 只取题干图；解析图（教师版灰框里的解法图）绝不跟着题走。
    // 余量在 figurePadBox 里算好（下边被答案线封顶），这里不再叠 pad
    const { stemFigureBox } = figureCropBox(item)
    const figureImage = stemFigureBox
        ? ((await cropPage(photoDataUrl, figurePadBox(stemFigureBox, item.answerTop)).catch(() => null)) ??
          undefined)
        : undefined

    return { problem: stem.trim(), figureImage }
}
