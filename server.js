import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const hlsJsPath = require.resolve('hls.js/dist/hls.min.js')

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const SOURCE = path.join(ROOT, 'work', 'test.mp4')
const SESSIONS_DIR = path.join(ROOT, 'work', 'sessions')
const PORT = 55028
const MAX_SESSIONS = 4
const IDLE_MS = 120000

const sessions = new Map()
let sourceDuration = 0

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Cache-Control', 'no-store')
}

function sendJson(res, code, data) {
  cors(res)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

function sendFile(req, res, filePath, contentType) {
  if (!fs.existsSync(filePath)) {
    sendJson(res, 404, { error: 'not found' })
    return
  }
  const stat = fs.statSync(filePath)
  cors(res)
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Content-Type', contentType)
  const range = req.headers.range
  if (!range) {
    res.writeHead(200, { 'Content-Length': stat.size })
    fs.createReadStream(filePath).pipe(res)
    return
  }
  const [startText, endText] = range.replace(/bytes=/, '').split('-')
  const start = Number(startText)
  const end = endText ? Number(endText) : stat.size - 1
  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Content-Length': end - start + 1,
  })
  fs.createReadStream(filePath, { start, end }).pipe(res)
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve({})
      }
    })
  })
}

function parseDuration(log) {
  const match = log.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!match) return 0
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

function probeDuration() {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, [
      '-hide_banner',
      '-analyzeduration', '100M',
      '-probesize', '100M',
      '-i', SOURCE,
    ], { windowsHide: true })
    let log = ''
    proc.stderr.on('data', (buf) => {
      log += buf.toString()
    })
    proc.on('close', () => resolve(parseDuration(log)))
    proc.on('error', () => resolve(0))
  })
}

function clampSs(ss) {
  const value = Math.max(0, Number(ss) || 0)
  if (sourceDuration > 0) return Math.min(value, Math.max(0, sourceDuration - 1))
  return value
}

function publicSession(session) {
  return {
    sessionId: session.id,
    status: session.status,
    error: session.error,
    ss: session.ss,
    time: session.time,
    duration: sourceDuration,
    playlistUrl: `/transcode/${session.id}/hls/index.m3u8`,
    playlist: fs.existsSync(session.playlist),
  }
}

function resetDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
}

function killProc(proc) {
  if (!proc?.pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    return
  }
  try {
    proc.kill('SIGTERM')
  } catch {
    // already exited
  }
  setTimeout(() => {
    try {
      proc.kill('SIGKILL')
    } catch {
      // already exited
    }
  }, 800)
}

function stopFfmpeg(session) {
  if (!session.proc) return Promise.resolve()
  session.stopping = true
  const proc = session.proc
  session.proc = null
  return new Promise((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      session.stopping = false
      resolve()
    }
    proc.once('close', done)
    try {
      killProc(proc)
    } catch {
      done()
      return
    }
    setTimeout(done, 2000)
  })
}

async function destroySession(id) {
  const session = sessions.get(id)
  if (!session) return
  await stopFfmpeg(session)
  sessions.delete(id)
  fs.rmSync(session.dir, { recursive: true, force: true })
}

function waitForPlaylist(session, timeoutMs = 120000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (session.status === 'error') {
        reject(new Error(session.error || '转码失败'))
        return
      }
      if (fs.existsSync(session.playlist) && fs.readFileSync(session.playlist, 'utf8').includes('.ts')) {
        resolve()
        return
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('等待首个分片超时'))
        return
      }
      setTimeout(tick, 400)
    }
    tick()
  })
}

async function startTranscode(session, ss = 0) {
  ss = clampSs(ss)
  const sameWindow = Math.abs((session.ss || 0) - ss) < 0.4
  if (session.proc && sameWindow && (session.status === 'transcoding' || session.status === 'ready')) {
    return
  }

  await stopFfmpeg(session)
  if (!fs.existsSync(SOURCE)) {
    session.status = 'error'
    session.error = `源文件不存在: ${SOURCE}`
    return
  }

  resetDir(session.dir)
  session.status = 'transcoding'
  session.error = ''
  session.time = ''
  session.ss = ss
  session.startedAt = Date.now()
  session.finishedAt = 0
  session.lastAccess = Date.now()

  const args = ['-hide_banner', '-y', '-fflags', '+genpts']
  if (ss > 0) args.push('-ss', ss.toFixed(3))
  args.push(
    '-analyzeduration', '100M',
    '-probesize', '100M',
    '-i', SOURCE,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p',
    '-an',
    '-g', '48',
    '-keyint_min', '48',
    '-sc_threshold', '0',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '0',
    '-hls_playlist_type', 'event',
    '-hls_flags', 'independent_segments',
    '-hls_segment_filename', path.join(session.dir, 'seg%05d.ts'),
    session.playlist,
  )

  console.log(`[ffmpeg ${session.id.slice(0, 8)}] ss=${ss}`)
  session.proc = spawn(ffmpegPath, args, { windowsHide: true })
  const proc = session.proc

  proc.stderr.on('data', (buf) => {
    const text = buf.toString()
    const match = text.match(/time=(\d+:\d+:\d+\.\d+)/)
    if (match) session.time = match[1]
  })
  proc.on('error', (error) => {
    if (proc !== session.proc) return
    session.status = 'error'
    session.error = error.message
    session.proc = null
  })
  proc.on('close', (code) => {
    if (session.stopping && proc !== session.proc) return
    if (proc !== session.proc) return
    session.proc = null
    session.finishedAt = Date.now()
    if (code === 0) {
      session.status = 'ready'
      console.log(`[ffmpeg ${session.id.slice(0, 8)}] done ${session.time}`)
    } else {
      session.status = 'error'
      session.error = `ffmpeg exit ${code}`
    }
  })
}

async function createSession(ss = 0) {
  if (sessions.size >= MAX_SESSIONS) {
    const error = new Error(`并发会话已满（最多 ${MAX_SESSIONS} 路）`)
    error.statusCode = 429
    throw error
  }
  const id = randomUUID()
  const dir = path.join(SESSIONS_DIR, id)
  const session = {
    id,
    dir,
    playlist: path.join(dir, 'index.m3u8'),
    proc: null,
    stopping: false,
    status: 'idle',
    error: '',
    ss: 0,
    time: '',
    startedAt: 0,
    finishedAt: 0,
    lastAccess: Date.now(),
  }
  sessions.set(id, session)
  await startTranscode(session, ss)
  await waitForPlaylist(session)
  return session
}

function touch(session) {
  session.lastAccess = Date.now()
}

setInterval(() => {
  const now = Date.now()
  for (const session of sessions.values()) {
    if (now - session.lastAccess > IDLE_MS) {
      console.log(`[idle] drop ${session.id.slice(0, 8)}`)
      destroySession(session.id)
    }
  }
}, 15000)

const HTML = `<!doctype html>
<meta charset="utf-8">
<title>hik session transcode</title>
<style>
  body{font-family:sans-serif;background:#111;color:#eee;padding:24px}
  .row{display:flex;gap:24px;flex-wrap:wrap}
  .col{flex:1;min-width:360px}
  video{width:100%;background:#000}
  .bar{height:10px;margin-top:12px;background:#333;cursor:pointer;border-radius:4px;overflow:hidden}
  .played{height:100%;width:0;background:#3ba9ff}
  button{margin-right:8px}
  code{color:#9cdcfe}
</style>
<h2>多会话试播（A / B 互不影响）</h2>
<p>每人一份 ffmpeg 和一份 ts 目录。关掉一列只停这一路。</p>
<div class="row">
  <div class="col" id="a"></div>
  <div class="col" id="b"></div>
</div>
<script src="/hls.min.js"></script>
<script>
  function player(rootId, label) {
    const root = document.getElementById(rootId)
    root.innerHTML = '<h3>' + label + '</h3>'
      + '<p class="meta">session: <code>-</code></p>'
      + '<video autoplay muted playsinline></video>'
      + '<div class="bar"><div class="played"></div></div>'
      + '<p class="time"></p>'
      + '<button data-act="start">开始</button>'
      + '<button data-act="stop">停止</button>'
    const video = root.querySelector('video')
    const bar = root.querySelector('.bar')
    const played = root.querySelector('.played')
    const timeEl = root.querySelector('.time')
    const meta = root.querySelector('.meta code')
    let sessionId = ''
    let duration = 0
    let ss = 0
    let hls
    function fmt(sec) {
      sec = Math.max(0, sec || 0)
      const h = Math.floor(sec / 3600)
      const m = Math.floor(sec % 3600 / 60)
      const s = Math.floor(sec % 60)
      return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':')
    }
    async function attach() {
      if (hls) hls.destroy()
      hls = new Hls({ liveSyncDurationCount: 1, manifestLoadingMaxRetry: 30, manifestLoadingRetryDelay: 800 })
      hls.loadSource('/transcode/' + sessionId + '/hls/index.m3u8?_=' + Date.now())
      hls.attachMedia(video)
      hls.on(Hls.Events.MANIFEST_PARSED, () => video.play())
    }
    async function start(nextSs) {
      ss = nextSs || 0
      const res = await fetch('/transcode/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ss }),
      })
      const data = await res.json()
      if (!res.ok) { alert(data.error || 'start failed'); return }
      sessionId = data.sessionId
      duration = data.duration || 0
      meta.textContent = sessionId.slice(0, 8)
      attach()
    }
    async function seek(nextSs) {
      if (!sessionId) { start(nextSs); return }
      ss = nextSs
      const res = await fetch('/transcode/' + sessionId + '/seek', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ss }),
      })
      const data = await res.json()
      if (!res.ok) { alert(data.error || 'seek failed'); return }
      attach()
    }
    async function stop() {
      if (!sessionId) return
      await fetch('/transcode/' + sessionId + '/stop', { method: 'POST' })
      sessionId = ''
      meta.textContent = '-'
      if (hls) { hls.destroy(); hls = null }
      video.removeAttribute('src')
      video.load()
    }
    video.addEventListener('click', () => { video.paused ? video.play() : video.pause() })
    bar.addEventListener('click', (e) => {
      if (!duration) return
      seek((e.offsetX / bar.clientWidth) * duration)
    })
    root.querySelector('[data-act=start]').onclick = () => start(0)
    root.querySelector('[data-act=stop]').onclick = stop
    setInterval(() => {
      const now = ss + (video.currentTime || 0)
      played.style.width = duration ? Math.min(100, now / duration * 100) + '%' : '0'
      timeEl.textContent = fmt(now) + ' / ' + fmt(duration)
    }, 400)
  }
  player('a', '用户 A')
  player('b', '用户 B')
</script>`

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  if (req.method === 'OPTIONS') {
    cors(res)
    res.writeHead(204)
    res.end()
    return
  }

  if (url.pathname === '/hls.min.js') {
    sendFile(req, res, hlsJsPath, 'text/javascript')
    return
  }

  if (url.pathname === '/transcode' && req.method === 'GET') {
    sendJson(res, 200, {
      duration: sourceDuration,
      maxSessions: MAX_SESSIONS,
      sessions: [...sessions.values()].map(publicSession),
    })
    return
  }

  if (url.pathname === '/transcode/start' && req.method === 'POST') {
    const body = await readJson(req)
    try {
      const session = await createSession(body.ss || 0)
      sendJson(res, 200, publicSession(session))
    } catch (error) {
      sendJson(res, error.statusCode || 503, { error: error.message })
    }
    return
  }

  const sessionMatch = url.pathname.match(/^\/transcode\/([0-9a-f-]{36})(?:\/(.*))?$/i)
  if (sessionMatch) {
    const session = sessions.get(sessionMatch[1])
    const rest = sessionMatch[2] || ''
    if (!session) {
      sendJson(res, 404, { error: 'session not found' })
      return
    }
    touch(session)

    if (rest === 'status' && req.method === 'GET') {
      sendJson(res, 200, publicSession(session))
      return
    }

    if (rest === 'seek' && req.method === 'POST') {
      const body = await readJson(req)
      try {
        await startTranscode(session, body.ss || 0)
        await waitForPlaylist(session)
        sendJson(res, 200, publicSession(session))
      } catch (error) {
        sendJson(res, 503, { error: error.message })
      }
      return
    }

    if (rest === 'stop' && (req.method === 'POST' || req.method === 'GET')) {
      await destroySession(session.id)
      sendJson(res, 200, { ok: true })
      return
    }

    if (rest === 'hls/index.m3u8') {
      const ss = url.searchParams.get('ss')
      if (ss != null && ss !== '') {
        try {
          await startTranscode(session, ss)
          await waitForPlaylist(session)
        } catch (error) {
          sendJson(res, 503, { error: error.message })
          return
        }
      }
      sendFile(req, res, session.playlist, 'application/vnd.apple.mpegurl')
      return
    }

    if (rest.startsWith('hls/')) {
      const name = path.basename(rest)
      if (!/^seg\d+\.ts$/.test(name)) {
        sendJson(res, 400, { error: 'bad segment' })
        return
      }
      sendFile(req, res, path.join(session.dir, name), 'video/MP2T')
      return
    }
  }

  cors(res)
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(HTML)
})

server.listen(PORT, '0.0.0.0', async () => {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true })
  console.log(`page     http://127.0.0.1:${PORT}/`)
  console.log(`start    POST http://127.0.0.1:${PORT}/transcode/start`)
  console.log(`source   ${SOURCE}`)
  console.log(`sessions max=${MAX_SESSIONS} idle=${IDLE_MS / 1000}s`)
  sourceDuration = await probeDuration()
  console.log(`duration ${sourceDuration || 'unknown'}s`)
})
