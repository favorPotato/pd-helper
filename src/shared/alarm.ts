const ALARM_HOST_ID = 'ig-helper-alarm'

let alarmTimer: number | null = null
let beepInterval: number | null = null

function beep(): void {
    try {
        const ctx = new AudioContext()
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'square'
        osc.frequency.setValueAtTime(880, ctx.currentTime)
        gain.gain.setValueAtTime(0.15, ctx.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3)
        osc.connect(gain)
        gain.connect(ctx.destination)
        osc.start()
        osc.stop(ctx.currentTime + 0.3)
    } catch {
    }
}

export function showAlarm(message: string, durationMs = 20_000): void {
    dismissAlarm()

    const host = document.createElement('div')
    host.id = ALARM_HOST_ID
    document.body.appendChild(host)
    const shadow = host.attachShadow({mode: 'closed'})

    const style = document.createElement('style')
    style.textContent = `
:host {
  position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;
  pointer-events: none;
}
.bar {
  background: #ef4444; color: #fff;
  padding: 14px 24px; font-size: 15px; font-weight: 700;
  text-align: center; pointer-events: auto; cursor: pointer;
  animation: flash 0.6s ease-in-out infinite alternate;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
@keyframes flash {
  from { background: #ef4444; }
  to { background: #dc2626; }
}
`
    const bar = document.createElement('div')
    bar.className = 'bar'
    bar.textContent = message
    bar.onclick = () => dismissAlarm()

    shadow.appendChild(style)
    shadow.appendChild(bar)

    beep()
    beepInterval = window.setInterval(beep, 2000)

    alarmTimer = window.setTimeout(() => dismissAlarm(), durationMs)
}

function dismissAlarm(): void {
    if (alarmTimer !== null) { clearTimeout(alarmTimer); alarmTimer = null }
    if (beepInterval !== null) { clearInterval(beepInterval); beepInterval = null }
    document.getElementById(ALARM_HOST_ID)?.remove()
}

export function isSessionError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error)
    const lower = msg.toLowerCase()
    return lower.includes('401') || lower.includes('login')
        || lower.includes('unauthorized') || lower.includes('expired')
        || lower.includes('登录') || lower.includes('登陆')
        || lower.includes('40000')
}
