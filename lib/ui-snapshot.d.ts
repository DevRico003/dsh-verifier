/**
 * `ui_snapshot`: headless screenshots of a page across viewports and colour
 * schemes in one call, plus the console/page/request errors seen while loading.
 * Nothing opens on the user's screen; the PNGs are meant for `analyze_image`.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from './config.js';
export interface Viewport {
    width: number;
    height: number;
}
/** `1440x900` → `{ width: 1440, height: 900 }`; throws on anything else. */
export declare function parseViewport(spec: string): Viewport;
export declare function snapshotRoot(configured: string): string;
export interface Shot {
    viewport: string;
    colorScheme: 'light' | 'dark';
    path: string;
    title: string;
}
export interface SnapshotResult {
    url: string;
    finalUrl: string;
    shots: Shot[];
    consoleErrors: string[];
    consoleWarnings: number;
    pageErrors: string[];
    failedRequests: string[];
    durationMs: number;
    browser: string;
    next: string;
}
interface SnapshotOptions {
    url: string;
    viewports: Viewport[];
    colorSchemes: ('light' | 'dark')[];
    fullPage: boolean;
    waitForSelector?: string;
    settleMs: number;
    outDir: string;
    channels: string[];
    headless: boolean;
    navigationTimeoutMs: number;
    signal?: AbortSignal;
}
export declare function takeSnapshots(options: SnapshotOptions): Promise<SnapshotResult>;
export declare function installSnapshotTool(ctx: Context, config: () => Config): void;
export {};
