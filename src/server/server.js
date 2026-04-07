/**
 * server.js — Webhook server for OpenClaw integration
 *
 * Runs an HTTP server on the VPS that OpenClaw can POST to.
 * OpenClaw sends:  { "command": "research: best home owners insurance" }
 * Server responds: { "status": "queued", "jobId": "abc123" }
 * Pipeline runs async and saves results to Obsidian + Anki.
 *
 * Endpoints:
 *   POST /run      — queue a pipeline job
 *   GET  /status/:jobId — check job status
 *   GET  /health   — health check
 *   GET  /jobs     — list recent jobs
 *
 * Security:
 *   All requests require header: X-API-Key: <WEBHOOK_SECRET>
 *   Set WEBHOOK_SECRET in .env — use a long random string
 *
 * Start with PM2:
 *   pm2 start src/server/server.js --name second-brain
 */

import 'dotenv/config'
import { createServer } from 'http'
import { randomUUID } from 'crypto'
import { parseIntent, validIntents } from '../pipeline/intent.js'
import { runPipelineWithIntent } from '../pipeline/run.js'
import { notifyJobComplete, notifyJobError } from '../connectors/openclaw.js'
import { extractPDF, savePDFToVault } from '../providers/pdf.js'
import { parseMultipart } from './multipart.js'
import { augmentTopic } from '../agents/augment.js'

const PORT   = parseInt(process.env.WEBHOOK_PORT   || '3579')
const SECRET = process.env.WEBHOOK_SECRET

if (!SECRET) {
  console.error('ERROR: WEBHOOK_SECRET not set in .env — server will not start')
  process.exit(1)
}

// ── In-memory job queue ───────────────────────────────────────────────────────
// For a production system, swap this for Redis or a SQLite store.
// For personal use on a VPS, in-memory is fine.

const jobs = new Map()   // jobId → job object
const MAX_JOBS = 100     // trim oldest jobs when over this

function addJob(jobId, data) {
  jobs.set(jobId, data)
  if (jobs.size > MAX_JOBS) {
    // Delete oldest entry
    const oldest = jobs.keys().next().value
    jobs.delete(oldest)
  }
}

// ── Auth middleware ───────────────────────────────────────────────────────────

function isAuthorized(req) {
  const key = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '')
  return key === SECRET
}

// ── Request body parser ───────────────────────────────────────────────────────

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')) }
      catch { resolve({}) }
    })
    req.on('error', reject)
  })
}

// ── Response helpers ──────────────────────────────────────────────────────────

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data, null, 2))
}

// ── Route handlers ────────────────────────────────────────────────────────────

async function handleRun(req, res) {
  const body = await readBody(req)
  const command = body.command || body.topic || body.message || ''

  if (!command) {
    return send(res, 400, {
      error: 'Missing "command" field',
      examples: {
        research: { command: 'research: best home owners insurance' },
        learning: { command: 'learning: Remotion full review' },
        augment:  { command: 'augment: home insurance', sourceText: 'Paste article text here...' },
      },
      validIntents: validIntents(),
    })
  }

  // Parse intent
  const parsed = parseIntent(command)

  // For augment intents: source text can come from body.sourceText
  // This is cleaner than embedding it in the command string for long articles
  if (parsed.isAugment && body.sourceText && !parsed.sourceText) {
    parsed.sourceText = body.sourceText
  }
  if (body.sourceName) {
    parsed.sourceName = body.sourceName
  }
  const jobId  = randomUUID().slice(0, 8)

  // Create job record
  const job = {
    jobId,
    command,
    intent:    parsed.intent,
    topic:     parsed.topic,
    status:    'queued',
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    result:    null,
    error:     null,
  }

  addJob(jobId, job)

  // Respond immediately — pipeline runs async
  send(res, 202, {
    status:  'queued',
    jobId,
    intent:  parsed.intent,
    topic:   parsed.topic,
    deck:    parsed.deckSuffix,
    folder:  parsed.vaultFolder,
    message: `Job queued. Check status at GET /status/${jobId}`,
  })

  // Run pipeline in background
  job.status    = 'running'
  job.startedAt = new Date().toISOString()

  runPipelineWithIntent(parsed)
    .then(async result => {
      job.status     = 'done'
      job.finishedAt = new Date().toISOString()
      job.result     = result
      console.log(`[${jobId}] ✓ Done: ${parsed.topic}`)
      // Notify OpenClaw so you get a message on WhatsApp/Telegram/Discord
      await notifyJobComplete(result, parsed.intent, parsed.topic)
    })
    .catch(async err => {
      job.status     = 'error'
      job.finishedAt = new Date().toISOString()
      job.error      = err.message
      console.error(`[${jobId}] ✗ Error: ${err.message}`)
      await notifyJobError(err.message, parsed.intent, parsed.topic)
    })
}

function handleStatus(req, res, jobId) {
  const job = jobs.get(jobId)
  if (!job) {
    return send(res, 404, { error: `Job ${jobId} not found` })
  }
  send(res, 200, job)
}

function handleJobs(req, res) {
  const recent = Array.from(jobs.values())
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 20)
    .map(j => ({
      jobId:     j.jobId,
      intent:    j.intent,
      topic:     j.topic,
      status:    j.status,
      createdAt: j.createdAt,
      finishedAt: j.finishedAt,
    }))

  send(res, 200, { jobs: recent, total: jobs.size })
}

function handleHealth(req, res) {
  send(res, 200, {
    status:  'ok',
    uptime:  Math.round(process.uptime()),
    jobs:    jobs.size,
    version: '1.0.0',
  })
}

// ── Upload handler ───────────────────────────────────────────────────────────
// Accepts multipart/form-data with:
//   file:       the PDF file
//   topic:      topic this relates to (optional — inferred from filename if omitted)
//   sourceName: human-readable source name (e.g. "WSJ — Home Insurance Guide")
//   intent:     augment | source (default: augment)

async function handleUpload(req, res) {
  const contentType = req.headers['content-type'] || ''

  if (!contentType.includes('multipart/form-data')) {
    return send(res, 400, {
      error: 'Expected multipart/form-data',
      hint: 'Send the PDF as a form field named "file"',
    })
  }

  let parsed
  try {
    parsed = await parseMultipart(req)
  } catch (err) {
    return send(res, 400, { error: `Could not parse upload: ${err.message}` })
  }

  const pdfFile = parsed.files?.file
  if (!pdfFile) {
    return send(res, 400, {
      error: 'No file found in upload',
      hint: 'Include a form field named "file" with the PDF attached',
    })
  }

  if (!pdfFile.mimetype?.includes('pdf') && !pdfFile.filename?.endsWith('.pdf')) {
    return send(res, 400, { error: 'Only PDF files are supported' })
  }

  const topic      = parsed.fields?.topic || pdfFile.filename?.replace(/\.pdf$/i, '').replace(/_/g, ' ') || 'Untitled'
  const sourceName = parsed.fields?.sourceName || pdfFile.filename || 'Uploaded PDF'
  const jobId      = randomUUID().slice(0, 8)

  const job = {
    jobId,
    command:    `augment: ${topic} [PDF: ${pdfFile.filename}]`,
    intent:     'Augment',
    topic,
    status:     'queued',
    createdAt:  new Date().toISOString(),
    startedAt:  null,
    finishedAt: null,
    result:     null,
    error:      null,
  }
  addJob(jobId, job)

  send(res, 202, {
    status:   'queued',
    jobId,
    intent:   'Augment',
    topic,
    filename: pdfFile.filename,
    size:     pdfFile.size,
    message:  `PDF received. Extracting text and processing... Check /status/${jobId}`,
  })

  // Process async
  job.status    = 'running'
  job.startedAt = new Date().toISOString()

  ;(async () => {
    try {
      // Step 1: Extract text from PDF
      const { assessExtraction } = await import('../providers/pdf.js')
      const extracted = await extractPDF(pdfFile.buffer)
      const quality   = assessExtraction(extracted.text, extracted.pageCount)

      console.log(`  [${jobId}] PDF quality: ${quality.assessment} (${quality.wordCount} words, ~${quality.avgWordsPerPage} words/page)`)

      if (extracted.wordCount < 50) {
        throw new Error(
          extracted.warnings[0] ||
          'PDF appears to be scanned or image-based — too little text extracted'
        )
      }

      // Step 2: Save PDF to Obsidian vault attachments
      let vaultPDFPath = null
      try {
        vaultPDFPath = await savePDFToVault(pdfFile.buffer, pdfFile.filename)
      } catch (e) {
        console.warn(`  ⚠ Could not save PDF to vault: ${e.message}`)
      }

      // Step 3: Run augment pipeline with extracted text
      const result = await augmentTopic(topic, extracted.text, {
        sourceName:   sourceName + (vaultPDFPath ? ` ([[${vaultPDFPath}]])` : ''),
        pdfMetadata:  extracted.metadata,
        vaultPDFPath,
      })

      job.status     = 'done'
      job.finishedAt = new Date().toISOString()
      job.result     = { ...result, pdfPath: vaultPDFPath, pages: extracted.pageCount, words: extracted.wordCount }

      console.log(\`[\${jobId}] ✓ PDF processed: \${topic} (\${extracted.pageCount} pages, \${extracted.wordCount} words)\`)
      await notifyJobComplete(result, 'Augment', topic)

    } catch (err) {
      job.status     = 'error'
      job.finishedAt = new Date().toISOString()
      job.error      = err.message
      console.error(\`[\${jobId}] ✗ PDF error: \${err.message}\`)
      await notifyJobError(err.message, 'Augment', topic)
    }
  })()
}

// ── Router ────────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url    = new URL(req.url, `http://localhost`)
  const path   = url.pathname
  const method = req.method

  console.log(`${new Date().toISOString()} ${method} ${path}`)

  // Health check — no auth required
  if (method === 'GET' && path === '/health') {
    return handleHealth(req, res)
  }

  // Auth check for all other routes
  if (!isAuthorized(req)) {
    return send(res, 401, { error: 'Unauthorized. Include X-API-Key header.' })
  }

  if (method === 'POST' && path === '/run') {
    return handleRun(req, res)
  }

  if (method === 'POST' && path === '/upload') {
    return handleUpload(req, res)
  }

  if (method === 'GET' && path.startsWith('/status/')) {
    const jobId = path.split('/')[2]
    return handleStatus(req, res, jobId)
  }

  if (method === 'GET' && path === '/jobs') {
    return handleJobs(req, res)
  }

  send(res, 404, {
    error: 'Route not found',
    routes: ['POST /run', 'POST /upload', 'GET /status/:jobId', 'GET /jobs', 'GET /health'],
  })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🧠 Second Brain webhook server running`)
  console.log(`   Port:    ${PORT}`)
  console.log(`   Health:  http://localhost:${PORT}/health`)
  console.log(`   Auth:    X-API-Key header required`)
  console.log(`\n   Send commands:`)
  console.log(`   POST /run { "command": "research: topic" }`)
  console.log(`   POST /run { "command": "learning: topic" }`)
  console.log(`   POST /run { "command": "review: topic" }\n`)
})

export default server
