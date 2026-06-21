// TikTok 人机验证墙权威检测：正则字面量唯一一份。
// 同进程三处检测函数（client.ts:detectTkCaptchaText / collector.ts:detectTkCaptcha /
// video-detail.ts:detectTkCaptchaHtml）一律复用此处；与权威份必须同步的仅剩 business-dispatchers.ts
// 的 tkDetailReadyProbe 探针内联那份（executeScript 注入页面上下文无法 import，硬约束）。
// 即：改正则只需同步「此处 + 探针内联」两处。
const TK_CAPTCHA_RE = /captcha-verify-container|captcha-verify-container-main-page|captcha_verify|secsdk-captcha|secsdk-captcha-drag-icon|Drag the puzzle piece into place|TUXModal/i

export function detectTkCaptchaWall(text: string): boolean {
    return TK_CAPTCHA_RE.test(text)
}
