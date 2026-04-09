import {strToU8, zipSync} from 'fflate'

export interface ArchiveFile {
    filename: string
    bytes: ArrayBuffer | Uint8Array
}

function toUint8Array(bytes: ArrayBuffer | Uint8Array): Uint8Array {
    if (ArrayBuffer.isView(bytes)) {
        return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    }
    return new Uint8Array(bytes)
}

export function createZipBlob(files: ArchiveFile[]): Blob {
    const entries: Record<string, Uint8Array> = {}
    for (const file of files) {
        entries[file.filename] = toUint8Array(file.bytes)
    }
    const zipped = zipSync(entries, {level: 0})
    const copied = Uint8Array.from(zipped)
    return new Blob([copied], {type: 'application/zip'})
}

export function createJsonArchiveFile(filename: string, data: unknown): ArchiveFile {
    return {
        filename,
        bytes: strToU8(JSON.stringify(data, null, 2))
    }
}

export function createTextArchiveFile(filename: string, text: string): ArchiveFile {
    return {
        filename,
        bytes: strToU8(text)
    }
}
