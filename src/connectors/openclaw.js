/**
 * openclaw.js — OpenClaw webhook notifier
 *
 * Posts completion notifications back to OpenClaw so you get a message
 * on WhatsApp/Telegram/Discord when a pipeline job finishes.
 *
 * OpenClaw webhook endpoints:
 *   POST /hooks/wake   — wake the agent with a text message
 *   POST /hooks/agent  — wake a specific agent with full routing control
 *
 * Setup in OpenClaw config.yaml:
 *   hooks:
 *     enabled: true
 *     token: "your-openclaw-hook-token"
 *     path: "/hooks"
 *     defaultSessionKey: "hook:second-brain"
 *     allowedAgentIds: ["main"]
 *
 * Then set in your .env:
 *   OPENCLAW_HOST=http://localhost:18789    # or your VPS/Tailscale address
 *   OPENCLAW_HOOKS_TOKEN=your-token-here
 *   OPENCLAW_AGENT_ID=main                  # optional: target specific agent
 *   OPENCLAW_NOTIFY=true                    # set false to disable notifications
 */

const OPENCLAW_HOST   = () => process.env.OPENCLAW_HOST  || 'http://localhost:18789'
const HOOKS_TOKEN     = () => process.env.OPENCLAW_HOOKS_TOKEN
const AGENT_ID        = () => process.env.OPENCLAW_AGENT_ID || 'main'
const NOTIFY_ENABLED  = () => process.env.OPENCLAW_NOTIFY !== 'false'

/**
 * Send a wake notification to OpenClaw.
 * The agent wakes up, reads the message, and replies to your messaging channel.
 *
 * @param {string} text  - Message the agent will receive
 * @param {object} opts  - { agentId, sessionKey, wakeMode, deliver }
 */
export async function notifyOpenClaw(text, opts = {}) {
  if (!NOTIFY_ENABLED()) return { skipped: true }

  const token = HOOKS_TOKEN()
  if (!token) {
    console.warn('  ⚠ OPENCLAW_HOOKS_TOKEN not set — skipping notification')
    return { skipped: true, reason: 'no token' }
  }

  const {
    agentId    = AGENT_ID(),
    sessionKey = 'hook:second-brain',
    wakeMode   = 'now',    // 'now' | 'next-heartbeat'
    deliver    = true,     // send agent reply to your messaging channel
  } = opts

  // Use /hooks/agent for full routing control
  const payload = {
    message:    text,
    agentId,
    sessionKey,
    wakeMode,
    deliver,
  }

  // OpenClaw webhook endpoint paths to try in order.
  // Different versions use different paths:
  //   /hooks/agent  — full routing (agentId, sessionKey, wakeMode)
  //   /hooks/wake   — simple wake (just message + agentId)
  //   /hooks        — base hooks path (some versions)
  const host = OPENCLAW_HOST()
  const endpoints = [
    `${host}/hooks/agent`,
    `${host}/hooks/wake`,
    `${host}/hooks`,
  ]

  let lastError = null

  for (const url of endpoints) {
    try {
      const response = await fetch(url, {
        method:  'POST',
        headers: {
          'Authorization':   `Bearer ${token}`,
          'Content-Type':    'application/json',
        },
        body:    JSON.stringify(payload),
        signal:  AbortSignal.timeout(10_000),
      })

      if (response.status === 405) {
        // Method not allowed — try next endpoint path
        console.warn(`  ⚠ ${url} returned 405 — trying next endpoint`)
        lastError = `405 Method Not Allowed on ${url}`
        continue
      }

      if (!response.ok) {
        const body = await response.text()
        throw new Error(`OpenClaw returned ${response.status}: ${body}`)
      }

      return { ok: true, status: response.status, endpoint: url }

    } catch (err) {
      if (err.message?.includes('405')) {
        lastError = err.message
        continue
      }
      // Connection errors (ECONNREFUSED, timeout) — don't try other paths
      console.warn(`  ⚠ OpenClaw notification failed: ${err.message}`)
      return { ok: false, error: err.message }
    }
  }

  // All endpoints returned 405
  console.warn(`  ⚠ OpenClaw notification failed: all endpoints returned 405.`)
  console.warn(`    Check that hooks.enabled=true in OpenClaw config.yaml and restart OpenClaw.`)
  console.warn(`    Host: ${host}`)
  return { ok: false, error: lastError }
}

/**
 * Send a job completion notification.
 * Called automatically by the pipeline after each successful run.
 *
 * Formats a clean summary message the agent can read and relay to you.
 */
export async function notifyJobComplete(result, intent, topic) {
  const emoji = {
    Research: '🔍',
    Learning: '📚',
    Study:    '🎓',
    Review:   '⭐',
    News:     '📰',
  }[intent] || '🧠'

  const lines = [
    `${emoji} Second Brain — ${intent} complete`,
    `Topic: "${topic}"`,
    `Note saved to Obsidian: ${result.note}`,
    `Anki deck: ${result.deck}`,
    `Cards added: ${result.newCards} new (${result.cards} total)`,
  ]

  if (result.notebook) {
    lines.push(`NotebookLM: ${result.notebook}`)
  }

  lines.push(`Open Obsidian to review and sync AnkiDroid.`)

  const message = lines.join('\n')

  return notifyOpenClaw(message, {
    wakeMode: 'now',
    deliver:  true,
  })
}

/**
 * Send a job error notification.
 */
export async function notifyJobError(error, intent, topic) {
  const message = [
    `❌ Second Brain — ${intent} failed`,
    `Topic: "${topic}"`,
    `Error: ${error}`,
    `Check the VPS logs: pm2 logs second-brain`,
  ].join('\n')

  return notifyOpenClaw(message, { wakeMode: 'now', deliver: true })
}

/**
 * Check if OpenClaw webhook endpoint is reachable.
 */
export async function checkOpenClaw() {
  const token = HOOKS_TOKEN()
  if (!token) return { ok: false, reason: 'OPENCLAW_HOOKS_TOKEN not set' }

  try {
    // Hit the health endpoint if available, or just check connectivity
    const response = await fetch(`${OPENCLAW_HOST()}/health`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal:  AbortSignal.timeout(3000),
    })
    return { ok: true, status: response.status }
  } catch {
    return { ok: false, reason: `Cannot reach ${OPENCLAW_HOST()}` }
  }
}
