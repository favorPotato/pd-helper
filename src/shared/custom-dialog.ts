export interface DialogField {
    key: string
    label: string
    type: 'number' | 'text' | 'date' | 'select' | 'radio' | 'info' | 'checkbox'
    value?: string | number | boolean
    options?: {label: string; value: string}[]
    presets?: {label: string; value: string | number}[]
    min?: number
    max?: number
    step?: number
    placeholder?: string
    required?: boolean
    hidden?: boolean
    group?: string
}

export interface DialogConfig {
    title: string
    fields: DialogField[]
    confirmText?: string
    cancelText?: string
    width?: number
}

export type DialogResult = Record<string, string | number | boolean>

const HOST_ID = 'ig-helper-dialog'

function getOrCreateHost(): {host: HTMLElement; shadow: ShadowRoot} {
    let host = document.getElementById(HOST_ID)
    if (host) {
        const shadow = (host as any).__shadow as ShadowRoot | undefined
        if (shadow) return {host, shadow}
        host.remove()
    }
    host = document.createElement('div')
    host.id = HOST_ID
    document.body.appendChild(host)
    const shadow = host.attachShadow({mode: 'closed'})
    ;(host as any).__shadow = shadow
    return {host, shadow}
}

function destroy(): void {
    document.getElementById(HOST_ID)?.remove()
}

function buildDatePresets(): {label: string; startDate: string; endDate: string}[] {
    const today = new Date()
    const fmt = (d: Date) => d.toISOString().slice(0, 10)
    const sub = (days: number) => {
        const d = new Date(today)
        d.setDate(d.getDate() - days)
        return d
    }
    const subMonths = (months: number) => {
        const d = new Date(today)
        d.setMonth(d.getMonth() - months)
        return d
    }
    return [
        {label: '1周', startDate: fmt(sub(7)), endDate: fmt(today)},
        {label: '2周', startDate: fmt(sub(14)), endDate: fmt(today)},
        {label: '1个月', startDate: fmt(subMonths(1)), endDate: fmt(today)},
        {label: '3个月', startDate: fmt(subMonths(3)), endDate: fmt(today)},
        {label: '6个月', startDate: fmt(subMonths(6)), endDate: fmt(today)},
        {label: '1年', startDate: fmt(sub(365)), endDate: fmt(today)}
    ]
}

const STYLE = `
:host {
  position: fixed; inset: 0; z-index: 2147483647;
  display: flex; align-items: center; justify-content: center;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  line-height: 1.5;
}
.backdrop {
  position: absolute; inset: 0;
  background: rgba(0,0,0,0.45);
}
.card {
  position: relative;
  background: #fff; border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.25);
  padding: 24px; min-width: 320px; max-width: 480px;
  max-height: 80vh; overflow-y: auto;
  animation: slideIn 0.15s ease-out;
}
@keyframes slideIn {
  from { transform: translateY(-12px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}
h3 {
  margin: 0 0 16px; font-size: 16px; font-weight: 700; color: #1a1a1a;
}
.field { margin-bottom: 14px; }
.field.hidden { display: none; }
label {
  display: block; font-size: 12px; font-weight: 600;
  color: #555; margin-bottom: 4px;
}
input[type="number"], input[type="text"], input[type="date"], select {
  width: 100%; padding: 8px 10px; font-size: 13px;
  border: 1px solid #d0d0d0; border-radius: 6px;
  box-sizing: border-box; outline: none;
  transition: border-color 0.15s;
  background: #fff; color: #1a1a1a;
}
input[type="number"]:focus, input[type="text"]:focus,
input[type="date"]:focus, select:focus { border-color: #0ea5e9; }
input[type="date"] { cursor: pointer; }
.checkbox-row {
  display: flex; align-items: center; gap: 8px; cursor: pointer;
}
.checkbox-row input[type="checkbox"] {
  width: 16px; height: 16px; margin: 0; cursor: pointer;
  accent-color: #0ea5e9;
}
.checkbox-row .checkbox-label {
  font-size: 13px; font-weight: 400; color: #1a1a1a; margin: 0;
}
.radio-group { display: flex; flex-direction: column; gap: 6px; }
.radio-row {
  display: flex; align-items: center; gap: 8px; cursor: pointer;
}
.radio-row input[type="radio"] {
  width: 16px; height: 16px; margin: 0; cursor: pointer;
  accent-color: #0ea5e9;
}
.radio-row .radio-label {
  font-size: 13px; color: #1a1a1a; margin: 0;
}
.info-block {
  font-size: 12px; color: #666; background: #f8f8f8;
  border-radius: 6px; padding: 8px 10px;
  border-left: 3px solid #0ea5e9;
}
.presets {
  display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px;
}
.preset-btn {
  padding: 4px 10px; font-size: 11px; font-weight: 600;
  border: 1px solid #d0d0d0; border-radius: 4px;
  background: #f5f5f5; color: #333; cursor: pointer;
  transition: all 0.12s;
}
.preset-btn:hover { background: #e0e0e0; }
.preset-btn.active { background: #0ea5e9; color: #fff; border-color: #0ea5e9; }
.date-presets {
  display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px;
}
.date-preset-btn {
  padding: 5px 12px; font-size: 12px; font-weight: 600;
  border: 1px solid #d0d0d0; border-radius: 6px;
  background: #f8f8f8; color: #333; cursor: pointer;
  transition: all 0.12s;
}
.date-preset-btn:hover { background: #e0e0e0; }
.date-preset-btn.active { background: #0ea5e9; color: #fff; border-color: #0ea5e9; }
.actions {
  display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px;
}
.btn {
  padding: 8px 20px; font-size: 13px; font-weight: 600;
  border: none; border-radius: 6px; cursor: pointer;
  transition: opacity 0.15s;
}
.btn:hover { opacity: 0.85; }
.btn-cancel { background: #e5e5e5; color: #333; }
.btn-confirm { background: #0ea5e9; color: #fff; }
.group-label {
  font-size: 11px; font-weight: 700; color: #999;
  text-transform: uppercase; letter-spacing: 0.5px;
  margin: 16px 0 8px; padding-bottom: 4px;
  border-bottom: 1px solid #eee;
}
`

export function showDialog(config: DialogConfig): Promise<DialogResult | null> {
    return new Promise((resolve) => {
        const {shadow} = getOrCreateHost()
        shadow.innerHTML = ''

        const style = document.createElement('style')
        style.textContent = STYLE
        shadow.appendChild(style)

        const backdrop = document.createElement('div')
        backdrop.className = 'backdrop'

        const card = document.createElement('div')
        card.className = 'card'
        if (config.width) card.style.minWidth = `${config.width}px`

        const title = document.createElement('h3')
        title.textContent = config.title
        card.appendChild(title)

        const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>()
        const checkboxes = new Map<string, HTMLInputElement>()
        const radioGroups = new Map<string, HTMLInputElement[]>()
        let lastGroup = ''

        const startDateField = config.fields.find(f => f.type === 'date' && f.key.includes('start'))
        const endDateField = config.fields.find(f => f.type === 'date' && f.key.includes('end'))
        const hasDateRange = !!(startDateField && endDateField)

        if (hasDateRange) {
            const presetRow = document.createElement('div')
            presetRow.className = 'date-presets'
            const presets = buildDatePresets()
            for (const preset of presets) {
                const btn = document.createElement('button')
                btn.type = 'button'
                btn.className = 'date-preset-btn'
                btn.textContent = preset.label
                btn.onclick = () => {
                    const si = inputs.get(startDateField.key) as HTMLInputElement | undefined
                    const ei = inputs.get(endDateField.key) as HTMLInputElement | undefined
                    if (si) si.value = preset.startDate
                    if (ei) ei.value = preset.endDate
                    presetRow.querySelectorAll('.date-preset-btn').forEach(b => b.classList.remove('active'))
                    btn.classList.add('active')
                }
                presetRow.appendChild(btn)
            }
            card.appendChild(presetRow)
        }

        for (const field of config.fields) {
            if (field.group && field.group !== lastGroup) {
                lastGroup = field.group
                const groupLabel = document.createElement('div')
                groupLabel.className = 'group-label'
                groupLabel.textContent = field.group
                card.appendChild(groupLabel)
            }

            const wrapper = document.createElement('div')
            wrapper.className = field.hidden ? 'field hidden' : 'field'

            if (field.type === 'info') {
                const block = document.createElement('div')
                block.className = 'info-block'
                block.textContent = field.label
                wrapper.appendChild(block)
                card.appendChild(wrapper)
                continue
            }

            if (field.type === 'checkbox') {
                const row = document.createElement('label')
                row.className = 'checkbox-row'
                const cb = document.createElement('input')
                cb.type = 'checkbox'
                cb.checked = field.value === true || field.value === 1
                const cbLabel = document.createElement('span')
                cbLabel.className = 'checkbox-label'
                cbLabel.textContent = field.label
                row.appendChild(cb)
                row.appendChild(cbLabel)
                wrapper.appendChild(row)
                checkboxes.set(field.key, cb)
                card.appendChild(wrapper)
                continue
            }

            if (field.type === 'radio' && field.options) {
                const lbl = document.createElement('label')
                lbl.textContent = field.label
                wrapper.appendChild(lbl)
                const group = document.createElement('div')
                group.className = 'radio-group'
                const radios: HTMLInputElement[] = []
                for (const opt of field.options) {
                    const row = document.createElement('label')
                    row.className = 'radio-row'
                    const r = document.createElement('input')
                    r.type = 'radio'
                    r.name = `dialog-radio-${field.key}`
                    r.value = opt.value
                    if (String(field.value) === opt.value) r.checked = true
                    const rLabel = document.createElement('span')
                    rLabel.className = 'radio-label'
                    rLabel.textContent = opt.label
                    row.appendChild(r)
                    row.appendChild(rLabel)
                    group.appendChild(row)
                    radios.push(r)
                }
                radioGroups.set(field.key, radios)
                wrapper.appendChild(group)
                card.appendChild(wrapper)
                continue
            }

            const lbl = document.createElement('label')
            lbl.textContent = field.label
            wrapper.appendChild(lbl)

            if (field.type === 'select' && field.options) {
                const sel = document.createElement('select')
                for (const opt of field.options) {
                    const o = document.createElement('option')
                    o.value = opt.value
                    o.textContent = opt.label
                    if (String(field.value) === opt.value) o.selected = true
                    sel.appendChild(o)
                }
                wrapper.appendChild(sel)
                inputs.set(field.key, sel)
            } else {
                const inp = document.createElement('input')
                inp.type = field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'
                if (field.value !== undefined) inp.value = String(field.value)
                if (field.placeholder) inp.placeholder = field.placeholder
                if (field.min !== undefined) inp.min = String(field.min)
                if (field.max !== undefined) inp.max = String(field.max)
                if (field.step !== undefined) inp.step = String(field.step)
                wrapper.appendChild(inp)
                inputs.set(field.key, inp)

                if (field.presets && field.presets.length > 0) {
                    const presetsRow = document.createElement('div')
                    presetsRow.className = 'presets'
                    for (const preset of field.presets) {
                        const btn = document.createElement('button')
                        btn.type = 'button'
                        btn.className = 'preset-btn'
                        btn.textContent = preset.label
                        btn.onclick = () => {
                            inp.value = String(preset.value)
                            presetsRow.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'))
                            btn.classList.add('active')
                        }
                        presetsRow.appendChild(btn)
                    }
                    wrapper.appendChild(presetsRow)
                }
            }

            card.appendChild(wrapper)
        }

        const actions = document.createElement('div')
        actions.className = 'actions'

        const cancelBtn = document.createElement('button')
        cancelBtn.type = 'button'
        cancelBtn.className = 'btn btn-cancel'
        cancelBtn.textContent = config.cancelText || '取消'
        cancelBtn.onclick = () => { destroy(); resolve(null) }

        const confirmBtn = document.createElement('button')
        confirmBtn.type = 'button'
        confirmBtn.className = 'btn btn-confirm'
        confirmBtn.textContent = config.confirmText || '确认'
        confirmBtn.onclick = () => {
            const result: DialogResult = {}
            for (const field of config.fields) {
                if (field.type === 'info') continue

                if (field.type === 'checkbox') {
                    const cb = checkboxes.get(field.key)
                    result[field.key] = cb ? cb.checked : false
                    continue
                }

                if (field.type === 'radio') {
                    const radios = radioGroups.get(field.key)
                    const checked = radios?.find(r => r.checked)
                    result[field.key] = checked ? checked.value : ''
                    continue
                }

                const el = inputs.get(field.key)
                if (!el) continue
                const raw = el.value.trim()
                if (field.required && !raw) {
                    ;(el as HTMLElement).style.borderColor = '#ef4444'
                    el.focus()
                    return
                }
                if (field.type === 'number') {
                    result[field.key] = raw ? Number(raw) : 0
                } else {
                    result[field.key] = raw
                }
            }
            destroy()
            resolve(result)
        }

        actions.appendChild(cancelBtn)
        actions.appendChild(confirmBtn)
        card.appendChild(actions)

        backdrop.onclick = () => { destroy(); resolve(null) }
        shadow.appendChild(backdrop)
        shadow.appendChild(card)

        const firstInput = card.querySelector('input[type="number"], input[type="text"], input[type="date"], select') as HTMLElement | null
        firstInput?.focus()
    })
}
