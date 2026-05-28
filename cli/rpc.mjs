import {CdpError} from './transport.mjs'
import {classifyEvalError} from './codes.mjs'

async function evaluate(session, expression, awaitPromise = true) {
    const res = await session.conn.send('Runtime.evaluate', {
        expression,
        awaitPromise,
        returnByValue: true,
        userGesture: false
    }, session.sessionId)

    // noinspection JSUnresolvedReference,JSUnresolvedVariable -- res 是 CDP Runtime.evaluate 响应，.exceptionDetails 字段由 CDP 协议保证存在
    if (res.exceptionDetails) {
        const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'evaluation failed'
        throw new CdpError(classifyEvalError(desc), `evaluate exception: ${desc}`)
    }
    // noinspection JSUnresolvedReference,JSUnresolvedVariable -- res 是 CDP Runtime.evaluate 响应，.result 字段由 CDP 协议保证存在
    return res.result.value
}

export async function callPd(session, method, args = []) {
    const argsJson = JSON.stringify(args)
    const expr = `(async () => {
        if (!globalThis.__pd) throw new Error('__pd not installed');
        const fn = globalThis.__pd[${JSON.stringify(method)}];
        if (typeof fn !== 'function') throw new Error('unknown __pd method: ' + ${JSON.stringify(method)});
        const args = ${argsJson};
        return await fn.apply(globalThis.__pd, args);
    })()`
    return await evaluate(session, expr, true)
}
