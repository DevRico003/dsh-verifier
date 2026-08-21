/**
 * `ui_snapshot`: headless screenshots of a page across viewports and colour
 * schemes in one call, plus the console/page/request errors seen while loading.
 * Nothing opens on the user's screen; the PNGs are meant for `analyze_image`.
 */

import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from './config.js'

export interface Viewport { width: number; height: number }

/** `1440x900` → `{ width: 1440, height: 900 }`; throws on anything else. */
export function parseViewport(spec: string): Viewport {
  const match = /^\s*(\d{3,5})\s*[x×]\s*(\d{3,5})\s*$/i.exec(spec)
  if (match === null) throw new Error(`ui_snapshot: viewport "${spec}" must look like 1440x900`)
  return { width: Number(match[1]), height: Number(match[2]) }
}

export function snapshotRoot(configured: string): string {
  if (configured !== '') return resolve(configured.replace(/^~(?=$|\/)/, homedir()))
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'verifier', 'snapshots')
}

function slug(text: string): string {
  return text.toLowerCase().replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'page'
}

export interface Shot { viewport: string; colorScheme: 'light' | 'dark'; path: string; title: string }

export interface SnapshotResult {
  url: string
  finalUrl: string
  shots: Shot[]
  consoleErrors: string[]
  consoleWarnings: number
  pageErrors: string[]
  failedRequests: string[]
  durationMs: number
  browser: string
  next: string
}

interface SnapshotOptions {
  url: string
  viewports: Viewport[]
  colorSchemes: ('light' | 'dark')[]
  fullPage: boolean
  waitForSelector?: string
  settleMs: number
  outDir: string
  channels: string[]
  headless: boolean
  navigationTimeoutMs: number
  signal?: AbortSignal
}

type PlaywrightModule = typeof import('playwright-core')

async function loadPlaywright(): Promise<PlaywrightModule> {
  try {
    return await import('playwright-core')
  } catch (error) {
    throw new Error(`ui_snapshot: playwright-core is not installed next to dsh-verifier-gate (${String(error)}); run pnpm install in the plugin checkout`)
  }
}

async function launch(pw: PlaywrightModule, channels: string[], headless: boolean): Promise<{ browser: import('playwright-core').Browser; channel: string }> {
  const errors: string[] = []
  for (const channel of channels) {
    try {
      const browser = channel === 'chromium'
        ? await pw.chromium.launch({ headless })
        : await pw.chromium.launch({ headless, channel })
      return { browser, channel }
    } catch (error) {
      errors.push(`${channel}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    }
  }
  throw new Error(`ui_snapshot: no launchable browser. Tried ${errors.join('; ')}`)
}

export async function takeSnapshots(options: SnapshotOptions): Promise<SnapshotResult> {
  const started = Date.now()
  const pw = await loadPlaywright()
  await mkdir(options.outDir, { recursive: true })
  const { browser, channel } = await launch(pw, options.channels, options.headless)
  const consoleErrors: string[] = []
  let consoleWarnings = 0
  const pageErrors: string[] = []
  const failedRequests: string[] = []
  const shots: Shot[] = []
  let finalUrl = options.url
  const onAbort = (): void => { void browser.close() }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    for (const colorScheme of options.colorSchemes) {
      for (const viewport of options.viewports) {
        if (options.signal?.aborted === true) throw new Error('ui_snapshot: aborted')
        const context = await browser.newContext({ viewport, colorScheme, deviceScaleFactor: 1 })
        const page = await context.newPage()
        page.setDefaultNavigationTimeout(options.navigationTimeoutMs)
        const tag = `${viewport.width}x${viewport.height}/${colorScheme}`
        page.on('console', message => {
          if (message.type() === 'error') consoleErrors.push(`[${tag}] ${message.text()}`)
          else if (message.type() === 'warning') consoleWarnings++
        })
        page.on('pageerror', error => { pageErrors.push(`[${tag}] ${error.message}`) })
        page.on('requestfailed', request => { failedRequests.push(`[${tag}] ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`.trim()) })
        try {
          await page.goto(options.url, { waitUntil: 'networkidle' }).catch(async () => { await page.goto(options.url, { waitUntil: 'load' }) })
          if (options.waitForSelector !== undefined) await page.waitForSelector(options.waitForSelector, { timeout: options.navigationTimeoutMs })
          if (options.settleMs > 0) await page.waitForTimeout(options.settleMs)
          finalUrl = page.url()
          const file = join(options.outDir, `${slug(options.url)}-${viewport.width}x${viewport.height}-${colorScheme}.png`)
          await page.screenshot({ path: file, fullPage: options.fullPage })
          shots.push({ viewport: `${viewport.width}x${viewport.height}`, colorScheme, path: file, title: await page.title() })
        } finally {
          await context.close()
        }
      }
    }
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
    await browser.close()
  }
  return {
    url: options.url,
    finalUrl,
    shots,
    consoleErrors,
    consoleWarnings,
    pageErrors,
    failedRequests,
    durationMs: Date.now() - started,
    browser: `${channel} headless=${options.headless}`,
    next: 'Run analyze_image with backend "detailed" on each path to get the visual verdict; fix console and page errors first.',
  }
}

export function installSnapshotTool(ctx: Context, config: () => Config): void {
  ctx.tools.register(defineTool({
    name: 'ui_snapshot',
    description:
      'Headless screenshots of one URL across several viewports and colour schemes in a single call, written as PNG files, '
      + 'plus the console errors, page errors and failed requests seen while loading. Nothing opens on the user\'s screen. '
      + 'Use it for every visual check of web work you built (design iterations, responsive and dark-mode checks), then call '
      + 'analyze_image with backend "detailed" on the returned paths. For clicking and typing use browser_open/browser_interact.',
    parameters: {
      url: { type: 'string', required: true, description: 'http(s) URL to capture (a dev server you started, for example http://127.0.0.1:3000/).' },
      viewports: { type: 'array', items: { type: 'string' }, description: 'Viewports as WIDTHxHEIGHT, e.g. ["1440x900","390x844"] (default from settings).' },
      colorSchemes: { type: 'array', items: { type: 'string' }, description: '"light", "dark" or both (default both).' },
      fullPage: { type: 'boolean', description: 'Capture the full scrollable page instead of the viewport (default false).' },
      waitForSelector: { type: 'string', description: 'CSS selector that must be present before the shot (for content loaded by the client).' },
      settleMs: { type: 'number', description: 'Extra wait after load for animations and charts (default 500).' },
      label: { type: 'string', description: 'Subfolder name for this batch, e.g. "round-2-after" (default: timestamp).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const { url, viewports, colorSchemes, fullPage, waitForSelector, settleMs, label } = args as {
        url: string; viewports?: string[]; colorSchemes?: string[]; fullPage?: boolean; waitForSelector?: string; settleMs?: number; label?: string
      }
      if (!/^https?:\/\//.test(url)) throw new Error('ui_snapshot: url must start with http:// or https://')
      const snapshot = config().snapshot
      const schemes = (colorSchemes ?? ['light', 'dark']).map(scheme => {
        if (scheme !== 'light' && scheme !== 'dark') throw new Error(`ui_snapshot: colour scheme "${scheme}" must be light or dark`)
        return scheme
      })
      const batch = label !== undefined && label !== '' ? slug(label) : new Date().toISOString().replace(/[:.]/g, '-')
      const result = await takeSnapshots({
        url,
        viewports: (viewports ?? snapshot.viewports).map(parseViewport),
        colorSchemes: schemes,
        fullPage: fullPage === true,
        ...waitForSelector !== undefined && waitForSelector !== '' ? { waitForSelector } : {},
        settleMs: settleMs ?? snapshot.settleMs,
        outDir: join(snapshotRoot(snapshot.dir), batch),
        channels: snapshot.channels,
        headless: snapshot.headless,
        navigationTimeoutMs: snapshot.navigationTimeoutMs,
        signal: exec.signal,
      })
      return { ...result, shots: result.shots.map(shot => ({ ...shot })) } as Record<string, import('@deepseek-ai/dsh-tools').JsonValue>
    },
  }))
}
