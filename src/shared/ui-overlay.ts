export type Platform = 'tiktok' | 'instagram' | 'nox' | 'unknown';

export interface OverlayButton {
    text: string;
    color: string;
    onClick: (e: MouseEvent) => void;
    enabled?: boolean;
    visible?: boolean;
}

export class FixedOverlay {
    private static HOST_ID = 'ig-helper-overlay';
    private shadowRoot: ShadowRoot | null = null;
    private statusBox: HTMLElement | null = null;
    private buttonContainer: HTMLElement | null = null;
    private logBox: HTMLElement | null = null;
    private collapseButton: HTMLButtonElement | null = null;
    private buttons: { element: HTMLButtonElement; config: OverlayButton }[] = [];
    private logLines: string[] = [];
    private static MAX_LOG_LINES = 100;
    private platform: Platform | 'unknown' = 'unknown';
    private collapsed = false;

    constructor() {
    }

    public async inject(platform: Platform | 'unknown' = 'unknown'): Promise<void> {
        if (window !== window.top) return;

        await this.waitForBody();

        let host = document.getElementById(FixedOverlay.HOST_ID);

        if (host) {
            if (!document.body.contains(host)) {
                document.body.appendChild(host);
            }

            if (!this.shadowRoot) {
                host.remove();
                host = null;
            }
        }

        if (!host) {
            host = document.createElement('div');
            host.id = FixedOverlay.HOST_ID;
            document.body.appendChild(host);
            this.shadowRoot = host.attachShadow({mode: 'closed'});
            this.render();
        }

        // Set the platform attribute on the host element
        this.platform = platform;
        host.setAttribute('data-ig-helper-platform', platform);
        this.setCollapsed(this.collapsed);
    }

    public setStatus(platform: Platform, text: string) {
        if (!this.statusBox) return;
        this.statusBox.className = `status ${platform}`;
        this.statusBox.textContent = text;

        // Sync enabled state after status update
        this.syncEnabledAttribute();
    }

    private syncEnabledAttribute() {
        const host = document.getElementById(FixedOverlay.HOST_ID);
        if (!host || !this.buttons) return;

        // Determine enabled state: enabled if at least one button is enabled
        const enabled = this.buttons.some(button => button.config.visible !== false && button.config.enabled !== false);
        host.setAttribute('data-ig-helper-enabled', enabled.toString());
    }

    private render() {
        if (!this.shadowRoot) return;

        const style = document.createElement('style');
        style.textContent = `
      :host {
        position: fixed;
        top: 60%;
        right: 0;
        bottom: auto;
        transform: translateY(-50%);
        z-index: 2147483647; /* Max safe z-index */
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        line-height: 1.5;
        pointer-events: none;
      }
      .card {
        width: 280px;
        background: #fafafa;
        border-radius: 12px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        padding: 16px;
        border: 1px solid #eee;
        box-sizing: border-box;
        color: #333;
        position: relative;
        transition: all 0.2s ease;
        pointer-events: auto;
        margin-right: 20px;
      }
      .status {
        padding: 8px 12px;
        border-radius: 6px;
        margin-bottom: 12px;
        font-size: 12px;
        font-weight: 600;
        text-align: center;
        transition: all 0.3s;
      }
      .status.tiktok { background: #1a1a1a; color: #fff; }
      .status.instagram { background: linear-gradient(45deg, #f09433, #e6683c, #dc2743, #cc2366, #bc1888); color: #fff; }
      .status.nox { background: #ff6b35; color: #fff; }
      .status.unknown { background: #e0e0e0; color: #666; }
      
      .buttons {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-bottom: 12px;
      }
      
      button {
        width: 100%;
        padding: 10px;
        font-size: 13px;
        font-weight: 600;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        transition: opacity 0.2s;
        color: #fff;
        display: flex;
        justify-content: center;
        align-items: center;
      }
      button:hover { opacity: 0.9; }
      button:disabled { opacity: 0.5; cursor: not-allowed; background: #999 !important; }
      
      .log {
        margin-top: 12px;
        padding: 8px;
        background: #fff;
        border: 1px solid #ddd;
        border-radius: 6px;
        font-family: ui-monospace, monospace;
        font-size: 10px;
        max-height: 150px;
        overflow-y: auto;
        white-space: pre-wrap;
        word-break: break-all;
        color: #333;
      }
      .collapse-btn {
        position: absolute;
        top: 8px;
        right: 8px;
        width: 24px;
        height: 24px;
        border-radius: 6px;
        border: none;
        background: #e9e9e9;
        color: #333;
        font-size: 16px;
        font-weight: 700;
        line-height: 1;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .collapse-btn:hover {
        background: #e9e9e9;
        color: #333;
      }
      :host([data-ig-helper-collapsed="true"]) .card {
        width: 56px;
        height: 48px;
        padding: 0;
        border-radius: 24px 0 0 24px;
        background: #222;
        border: 1px solid rgba(255, 255, 255, 0.35);
        border-right: none;
        box-shadow: 0 4px 16px rgba(0,0,0,0.4);
        display: flex;
        align-items: center;
        justify-content: center;
        margin-right: 0;
        opacity: 0.7;
      }
      :host([data-ig-helper-collapsed="true"][data-ig-helper-platform="instagram"]) .card {
        background: linear-gradient(45deg, #f09433, #e6683c, #dc2743, #cc2366, #bc1888);
        box-shadow: 0 6px 18px rgba(188, 24, 136, 0.35);
      }
      :host([data-ig-helper-collapsed="true"][data-ig-helper-platform="tiktok"]) .card {
        background: #111;
        box-shadow: 0 6px 18px rgba(0,0,0,0.45);
      }
      :host([data-ig-helper-collapsed="true"][data-ig-helper-platform="nox"]) .card {
        background: #ff6b35;
        box-shadow: 0 6px 18px rgba(255, 107, 53, 0.35);
      }
      :host([data-ig-helper-collapsed="true"][data-ig-helper-platform="unknown"]) .card {
        background: #444;
      }
      :host([data-ig-helper-collapsed="true"]) .card:hover {
        opacity: 1;
        transform: translateX(-4px);
      }
      :host([data-ig-helper-collapsed="true"]) .status,
      :host([data-ig-helper-collapsed="true"]) .buttons,
      :host([data-ig-helper-collapsed="true"]) .log {
        display: none;
      }
      :host([data-ig-helper-collapsed="true"]) .collapse-btn {
        position: static;
        width: 100%;
        height: 100%;
        border-radius: 24px 0 0 24px;
        font-size: 16px;
        font-weight: 800;
        color: #fff;
      }
      :host([data-ig-helper-collapsed="true"]) .collapse-btn:hover {
        background: transparent;
        color: #fff;
      }
    `;

        const card = document.createElement('div');
        card.className = 'card';

        this.statusBox = document.createElement('div');
        this.statusBox.className = 'status unknown';
        this.statusBox.textContent = 'Initializing...';

        this.buttonContainer = document.createElement('div');
        this.buttonContainer.className = 'buttons';

        this.logBox = document.createElement('div');
        this.logBox.className = 'log';

        this.collapseButton = document.createElement('button');
        this.collapseButton.className = 'collapse-btn';
        this.collapseButton.type = 'button';
        this.collapseButton.onclick = (e) => {
            e.stopPropagation();
            this.setCollapsed(!this.collapsed);
        };

        if (this.logLines.length > 0) {
            this.logBox.textContent = this.logLines.join('\n') + '\n';
        }

        card.appendChild(this.statusBox);
        card.appendChild(this.collapseButton);
        card.appendChild(this.buttonContainer);
        card.appendChild(this.logBox);

        this.shadowRoot.innerHTML = '';
        this.shadowRoot.appendChild(style);
        this.shadowRoot.appendChild(card);
        this.setCollapsed(this.collapsed);
    }

    private getCollapsedLabel(): string {
        if (this.platform === 'instagram') return 'IG';
        if (this.platform === 'tiktok') return 'TK';
        if (this.platform === 'nox') return 'NOX';
        return 'IG';
    }

    private setCollapsed(collapsed: boolean) {
        this.collapsed = collapsed;
        const host = document.getElementById(FixedOverlay.HOST_ID);
        if (host) {
            host.setAttribute('data-ig-helper-collapsed', collapsed.toString());
        }
        if (this.collapseButton) {
            this.collapseButton.textContent = collapsed ? this.getCollapsedLabel() : '-';
            const label = collapsed ? 'Expand' : 'Collapse';
            this.collapseButton.setAttribute('aria-label', label);
            this.collapseButton.setAttribute('title', label);
        }
    }

    private waitForBody(): Promise<void> {
        return new Promise(resolve => {
            if (document.body) return resolve();
            const observer = new MutationObserver(() => {
                if (document.body) {
                    observer.disconnect();
                    resolve();
                }
            });
            observer.observe(document.documentElement, {childList: true});
        });
    }

    public addButton(text: string, color: string, onClick: (e: MouseEvent) => void, enabled: boolean = true) {
        if (!this.buttonContainer) return;

        const existingIndex = this.buttons.findIndex(b => b.config.text === text);
        if (existingIndex >= 0) {
            const {element} = this.buttons[existingIndex];
            const visible = this.buttons[existingIndex].config.visible !== false;
            element.onclick = onClick;
            element.style.background = color;
            element.style.display = visible ? 'flex' : 'none';
            element.disabled = !enabled;
            this.buttons[existingIndex].config = {text, color, onClick, enabled, visible};
            // Sync enabled state when button is updated
            this.syncEnabledAttribute();
            return;
        }

        const btn = document.createElement('button');
        btn.textContent = text;
        btn.style.background = color;
        btn.style.display = 'flex';
        btn.onclick = onClick;
        btn.disabled = !enabled;

        this.buttonContainer.appendChild(btn);
        this.buttons.push({element: btn, config: {text, color, onClick, enabled, visible: true}});
        // Sync enabled state when button is added
        this.syncEnabledAttribute();
    }

    public setButtonVisible(indexOrText: number | string, visible: boolean) {
        let target: { element: HTMLButtonElement; config: OverlayButton } | undefined;

        if (typeof indexOrText === 'number') {
            target = this.buttons[indexOrText];
        } else {
            target = this.buttons.find(b => b.config.text === indexOrText);
        }

        if (target) {
            target.element.style.display = visible ? 'flex' : 'none';
            target.config.visible = visible;
        }

        this.syncEnabledAttribute();
    }

     public setButtonText(indexOrText: number | string, text: string) {
         let target: { element: HTMLButtonElement; config: OverlayButton } | undefined;

        if (typeof indexOrText === 'number') {
            target = this.buttons[indexOrText];
        } else {
            target = this.buttons.find(b => b.config.text === indexOrText);
        }

         if (target) {
             target.element.textContent = text;
         }
     }

    public setButtonEnabled(indexOrText: number | string, enabled: boolean) {
        let target: { element: HTMLButtonElement; config: OverlayButton } | undefined;

        if (typeof indexOrText === 'number') {
            target = this.buttons[indexOrText];
        } else {
            target = this.buttons.find(b => b.config.text === indexOrText);
        }

        if (target) {
            target.element.disabled = !enabled;
            target.config.enabled = enabled;
        }

        // Sync enabled state when button is enabled/disabled
        this.syncEnabledAttribute();
    }

    public log(message: unknown) {
        const time = new Date().toLocaleTimeString();
        const sanitizedMsg = this.sanitize(message);
        const line = `[${time}] ${sanitizedMsg}`;

        this.logLines.push(line);

        if (this.logLines.length > FixedOverlay.MAX_LOG_LINES) {
            this.logLines.shift();
        }

        if (this.logBox) {
            this.logBox.textContent = this.logLines.join('\n') + '\n';
            this.logBox.scrollTop = this.logBox.scrollHeight;
        }
    }

    private sanitize(input: unknown): string {
        let str: string;
        try {
            if (typeof input === 'string') {
                str = input;
            } else if (input instanceof Error) {
                str = input.message;
            } else {
                str = JSON.stringify(input, null, 2);
            }
        } catch (e) {
            str = '[Circular/Unserializable]';
        }

        str = str.replace(/(https?:\/\/[^\s"']+)\?[^\s"']+/g, '$1?[REDACTED]');

        str = str.replace(/(sessionid=)([^;&"\s]+)/g, '$1[REDACTED]');
        str = str.replace(/(Authorization[:=]\s*)([^;\n]+)/gi, '$1[REDACTED]');

        return str;
    }

    public observeUrl(callback: (url: string) => void, intervalMs: number = 500): () => void {
        let lastUrl = location.href;

        const check = () => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                callback(lastUrl);
            }
        };

        window.addEventListener('popstate', check);
        window.addEventListener('hashchange', check);
        const timer = setInterval(check, intervalMs);

        return () => {
            window.removeEventListener('popstate', check);
            window.removeEventListener('hashchange', check);
            clearInterval(timer);
        };
    }
}
