import {FixedOverlay} from '../../shared/ui-overlay';

export class UiHelper {
    private static overlay: FixedOverlay | null = null;
    private static urlCleanup: (() => void) | null = null;

    public static async inject(handlers: {
        onBridge: () => Promise<void>
        onDownload: () => Promise<void>
        onCollect: () => Promise<void>
    }) {
        // Ensure we have a single overlay instance
        if (!UiHelper.overlay) {
            UiHelper.overlay = new FixedOverlay();
        }

        // Always call inject to ensure the overlay is in place
        await UiHelper.overlay.inject('tiktok');

        // Set status to TikTok style
        UiHelper.overlay.setStatus('tiktok', 'TikTok (Non-Video)');

        // Add/update buttons (initially disabled)
        UiHelper.overlay.addButton('转发', '#405DE6', async (e) => {
            e.stopPropagation();
            await handlers.onBridge();
        }, false);

        UiHelper.overlay.addButton('下载', '#fe2c55', async (e) => {
            e.stopPropagation();
            await handlers.onDownload();
        }, false);

        UiHelper.overlay.addButton('采集', '#0ea5e9', async (e) => {
            e.stopPropagation();
            await handlers.onCollect();
        }, false);

        // Register URL monitoring
        if (UiHelper.urlCleanup) {
            UiHelper.urlCleanup();
        }

        UiHelper.urlCleanup = UiHelper.overlay.observeUrl(async () => {
            await UiHelper.refreshEnabledState();
        });

        // Refresh enabled state
        await UiHelper.refreshEnabledState();
    }

    private static async refreshEnabledState() {
        if (!UiHelper.overlay) return;

        const isVideo = VideoHelper.isVideoPage();
        const isProfile = UrlHelper.isProfilePage();

        // Set status text based on page type
        if (isVideo) {
            UiHelper.overlay.setStatus('tiktok', 'TikTok (Video)');
        } else if (isProfile) {
            UiHelper.overlay.setStatus('tiktok', 'TikTok (Profile)');
        } else {
            UiHelper.overlay.setStatus('tiktok', 'TikTok (Non-Video)');
        }

        // Enable/disable buttons based on page type
        UiHelper.overlay.setButtonVisible('转发', isVideo);
        UiHelper.overlay.setButtonEnabled('转发', isVideo);
        UiHelper.overlay.setButtonVisible('下载', isVideo);
        UiHelper.overlay.setButtonEnabled('下载', isVideo);
        UiHelper.overlay.setButtonVisible('采集', isProfile);
        UiHelper.overlay.setButtonEnabled('采集', isProfile);
    }

    public static log(message: unknown) {
        if (UiHelper.overlay) {
            UiHelper.overlay.log(message);
        }
    }
}

export class VideoHelper {
    static isVideoPage(): boolean {
        return /\/video\/\d+/.test(window.location.pathname);
    }

    static parseMp4Meta(buffer: ArrayBuffer): import('./types').Mp4Meta {
        const bytes = new Uint8Array(buffer);

        function readU32(off: number): number {
            return ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
        }

        function readU64(off: number): bigint {
            const hi = BigInt(readU32(off));
            const lo = BigInt(readU32(off + 4));
            return (hi << 32n) | lo;
        }

        function readType(off: number): string {
            return String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
        }

        function iterBoxes(start: number, end: number): any[] {
            const out: any[] = [];
            let off = start;
            while (off + 8 <= end) {
                const size32 = readU32(off);
                const type = readType(off + 4);
                let header = 8;
                let size = size32;
                if (size32 === 1) {
                    if (off + 16 > end) break;
                    size = Number(readU64(off + 8));
                    header = 16;
                } else if (size32 === 0) {
                    size = end - off;
                }
                if (!size || off + size > end) break;
                out.push({type, off, size, header, dataOff: off + header, endOff: off + size});
                off += size;
            }
            return out;
        }

        function findBox(start: number, end: number, type: string): any | null {
            const boxes = iterBoxes(start, end);
            for (const b of boxes) {
                if (b.type === type) return b;
            }
            return null;
        }

        function findDeep(start: number, end: number, path: string[]): any | null {
            let curStart = start;
            let curEnd = end;
            let b: any | null = null;
            for (const t of path) {
                b = findBox(curStart, curEnd, t);
                if (!b) return null;
                curStart = b.dataOff;
                curEnd = b.endOff;
            }
            return b;
        }

        try {
            const moov = findBox(0, bytes.byteLength, 'moov');
            if (!moov) return {width: 0, height: 0, durationSec: 0};

            let durationSec = 0;
            const mvhd = findBox(moov.dataOff, moov.endOff, 'mvhd');
            if (mvhd) {
                const v = bytes[mvhd.dataOff];
                if (v === 0) {
                    const timescale = readU32(mvhd.dataOff + 12);
                    const duration = readU32(mvhd.dataOff + 16);
                    if (timescale) durationSec = duration / timescale;
                } else if (v === 1) {
                    const timescale = readU32(mvhd.dataOff + 20);
                    const duration = readU64(mvhd.dataOff + 24);
                    if (timescale) durationSec = Number(duration) / timescale;
                }
            }

            let width = 0;
            let height = 0;
            const traks = iterBoxes(moov.dataOff, moov.endOff).filter((b) => b.type === 'trak');
            for (const trak of traks) {
                const hdlr = findDeep(trak.dataOff, trak.endOff, ['mdia', 'hdlr']);
                if (!hdlr) continue;
                const handlerType = readType(hdlr.dataOff + 8);
                if (handlerType !== 'vide') continue;
                const tkhd = findBox(trak.dataOff, trak.endOff, 'tkhd');
                if (!tkhd) continue;
                if (tkhd.endOff - 8 < tkhd.dataOff) continue;
                const wFixed = readU32(tkhd.endOff - 8);
                const hFixed = readU32(tkhd.endOff - 4);
                width = wFixed >>> 16;
                height = hFixed >>> 16;
                break;
            }

            return {width, height, durationSec};
        } catch {
            return {width: 0, height: 0, durationSec: 0};
        }
    }
}

export class UrlHelper {
    static isProfilePage(url: string = window.location.href): boolean {
        const pathname = new URL(url, window.location.origin).pathname
        return /^\/@[^/]+\/?$/.test(pathname)
    }

    static getUsernameFromProfilePage(url: string = window.location.href): string | null {
        const pathname = new URL(url, window.location.origin).pathname
        const match = pathname.match(/^\/@([^/]+)\/?$/)
        return match ? match[1] : null
    }
}
