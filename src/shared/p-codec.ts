import {zlibSync, unzlibSync} from 'fflate'

function bytesToBase64(bytes: Uint8Array): string {
    let binary = ''
    const chunkSize = 0x8000
    for (let index = 0; index < bytes.length; index += chunkSize) {
        const chunk = bytes.subarray(index, index + chunkSize)
        binary += String.fromCharCode(...chunk)
    }
    return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i)
    }
    return bytes
}

export function encodeP(obj: unknown): string {
    const json = JSON.stringify(obj)
    const urlEncoded = encodeURIComponent(json)
    const compressed = zlibSync(new TextEncoder().encode(urlEncoded), {level: 9})
    return bytesToBase64(compressed).replace(/=+$/, '')
}

export function decodeP(pStr: string): unknown {
    const padded = pStr + '='.repeat((4 - (pStr.length % 4)) % 4)
    const bytes = base64ToBytes(padded)
    const decompressed = unzlibSync(bytes)
    const urlEncoded = new TextDecoder().decode(decompressed)
    return JSON.parse(decodeURIComponent(urlEncoded))
}
