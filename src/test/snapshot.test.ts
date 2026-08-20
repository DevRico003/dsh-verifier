import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseViewport, snapshotRoot, takeSnapshots } from '../ui-snapshot.js'

test('parseViewport and snapshotRoot', () => {
  assert.deepEqual(parseViewport('1440x900'), { width: 1440, height: 900 })
  assert.deepEqual(parseViewport(' 390 X 844 '), { width: 390, height: 844 })
  assert.throws(() => parseViewport('wide'))
  assert.ok(snapshotRoot('').endsWith(join('verifier', 'snapshots')))
  assert.equal(snapshotRoot('/tmp/shots'), '/tmp/shots')
})

test('takeSnapshots renders light and dark across viewports headless and reports console errors', async (t) => {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end('<!doctype html><title>snap</title><style>body{background:#fff}@media(prefers-color-scheme:dark){body{background:#000}}</style><h1>hi</h1><script>console.error("boom")</script>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const outDir = await mkdtemp(join(tmpdir(), 'dsh-verifier-snap-'))
  try {
    let result
    try {
      result = await takeSnapshots({
        url: `http://127.0.0.1:${port}/`,
        viewports: [{ width: 800, height: 600 }, { width: 390, height: 844 }],
        colorSchemes: ['light', 'dark'],
        fullPage: false,
        settleMs: 0,
        outDir,
        channels: ['chrome', 'chromium'],
        headless: true,
        navigationTimeoutMs: 20_000,
      })
    } catch (error) {
      if (String(error).includes('no launchable browser')) { t.skip('no Chrome/Chromium on this machine'); return }
      throw error
    }
    assert.equal(result.shots.length, 4)
    for (const shot of result.shots) assert.ok((await stat(shot.path)).size > 1000, shot.path)
    assert.equal(result.shots[0]!.title, 'snap')
    assert.ok(result.consoleErrors.some(line => line.includes('boom')))
    assert.ok(result.browser.includes('headless=true'))
  } finally {
    server.close()
  }
})
