const GAS_URL_ENV = 'PD_HELPER_GAS_URL'
const GAS_TOKEN_ENV = 'PD_HELPER_GAS_TOKEN'

class GasError extends Error {}

export async function callGas(action, payload, {url, token}) {
    let res
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({action, payload, token})
        })
    } catch (e) {
        throw new GasError(`network error: ${e instanceof Error ? e.message : String(e)}`)
    }
    const text = await res.text()
    let data
    try {
        data = JSON.parse(text)
    } catch {
        throw new GasError(`non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`)
    }
    if (!res.ok) throw new GasError(`HTTP ${res.status}: ${data && data.error ? data.error : text.slice(0, 200)}`)
    if (!data || data.ok !== true) throw new GasError(`apps script error: ${data && data.error ? data.error : 'unknown'}`)
    return data
}

export async function runSheetCommand(args) {
    const action = args.rest[0]
    if (!action) {
        console.error('sheet: missing <action>')
        return 1
    }

    const url = (process.env[GAS_URL_ENV] || '').trim()
    const token = (process.env[GAS_TOKEN_ENV] || '').trim()
    if (!url) {
        console.error(`sheet: ${GAS_URL_ENV} not set`)
        return 1
    }

    let payload = args.params
    if (args.flags.payload !== undefined) {
        try {
            payload = JSON.parse(args.flags.payload)
        } catch (e) {
            console.error(`sheet: invalid --payload JSON: ${e instanceof Error ? e.message : String(e)}`)
            return 1
        }
    }

    try {
        const data = await callGas(action, payload, {url, token})
        process.stdout.write(JSON.stringify(data) + '\n')
        return 0
    } catch (e) {
        console.error(`sheet: ${e instanceof Error ? e.message : String(e)}`)
        return 1
    }
}
