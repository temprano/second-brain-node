/**
 * obsidian.js — Obsidian Local REST API connector
 * 
 * Writes markdown notes directly into your vault.
 * Requires the "Local REST API" community plugin to be installed and enabled.
 * Get your API key from: Obsidian → Settings → Local REST API → API Key
 */

import { readFileSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

const BASE = () => `https://${process.env.OBSIDIAN_HOST || '127.0.0.1'}:${process.env.OBSIDIAN_PORT || '27124'}`
const KEY  = () => process.env.OBSIDIAN_API_KEY

/**
 * Build a formatted Obsidian markdown note from research data
 */
export function buildNote(data, topic) {
  const today = new Date().toISOString().split('T')[0]
  const deck = `${process.env.ANKI_DECK_PREFIX || 'Learning'}::${data.deck_suffix}`

  // ── Frontmatter ──
  const frontmatter = `---
type: research
topic: ${data.topic_tag}
tags: [${data.topic_tag}, openclaw-generated, to-sync]
source: "Second Brain Pipeline — ${today}"
reviewed: false
deck: "${deck}"
created: ${today}
---`

  // ── Key concepts section ──
  const conceptsMd = (data.key_concepts || [])
    .map(c => `### ${c.concept}\n${c.explanation}\n*Why it matters:* ${c.why_it_matters || '—'}`)
    .join('\n\n')

  // ── Surprising facts ──
  const surprisingMd = (data.surprising_facts || [])
    .map(f => `- ${f}`)
    .join('\n') || '- None noted'

  // ── Misconceptions ──
  const misconceptionsMd = (data.common_misconceptions || [])
    .map(m => `- ❌ ${m}`)
    .join('\n') || '- None noted'

  // ── Sources ──
  const sourcesMd = (data.sources || [])
    .map(s => `- ${s}`)
    .join('\n') || '- See web search results'

  // ── Connections ──
  const connectionsMd = (data.connections || [])
    .map(c => `- [[${c}]]`)
    .join('\n') || '- None'

  // ── Anki cards ──
  const cardsMd = (data.flashcards || []).map(card => {
    if (card.type === 'basic') {
      return `START
Basic
Deck: ${deck}
Tags: ${data.topic_tag}, openclaw-generated
${card.front}
Back: ${card.back}
END`
    } else {
      return `START
Cloze
Deck: ${deck}
Tags: ${data.topic_tag}, openclaw-generated
${card.text}
END`
    }
  }).join('\n\n')

  const body = `
# ${data.title}

> ⚠️ *Pipeline generated — review before treating as authoritative*

## Summary
${data.summary}

## Key Concepts
${conceptsMd}

## Surprising / Counterintuitive
${surprisingMd}

## Common Misconceptions
${misconceptionsMd}

## Sources
${sourcesMd}

## Connections
${connectionsMd}

---

## 🃏 Anki Cards

${cardsMd}
`

  return frontmatter + body
}

/**
 * Write a note to Obsidian vault via Local REST API.
 * Falls back to local file if Obsidian isn't reachable.
 */
export async function writeNote(filename, content) {
  const url = `${BASE()}/vault/${filename}`

  try {
    const { default: fetch } = await import('node-fetch')
    const resp = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${KEY()}`,
        'Content-Type': 'text/markdown',
      },
      body: content,
      // Self-signed cert — disable verification for localhost
      agent: new (await import('https')).Agent({ rejectUnauthorized: false }),
    })

    if (resp.status === 200 || resp.status === 201 || resp.status === 204) {
      return { success: true, location: 'obsidian', path: filename }
    }

    throw new Error(`Obsidian API returned ${resp.status}: ${await resp.text()}`)

  } catch (err) {
    // Fallback: save locally
    if (process.env.LOCAL_BACKUP === 'true' || err.code === 'ECONNREFUSED') {
      const backupDir = process.env.LOCAL_BACKUP_PATH || './output_notes'
      mkdirSync(backupDir, { recursive: true })
      const safeName = filename.replace(/\//g, '_')
      const localPath = join(backupDir, safeName)
      writeFileSync(localPath, content, 'utf8')
      return { success: false, location: 'local', path: localPath, error: err.message }
    }
    throw err
  }
}

/**
 * Check if Obsidian Local REST API is reachable
 */
export async function checkObsidian() {
  try {
    const { default: fetch } = await import('node-fetch')
    const resp = await fetch(`${BASE()}/`, {
      headers: { Authorization: `Bearer ${KEY()}` },
      agent: new (await import('https')).Agent({ rejectUnauthorized: false }),
      signal: AbortSignal.timeout(3000),
    })
    return resp.ok || resp.status === 200
  } catch {
    return false
  }
}

/**
 * PATCH a note — append content after a specific heading, or at the end.
 * Uses the Local REST API PATCH endpoint for surgical edits.
 *
 * @param {string} filename  - Vault-relative path e.g. "100-Learning/Research/My Note.md"
 * @param {string} content   - Markdown content to append
 * @param {string} heading   - Heading to insert after (optional — defaults to end of file)
 */
export async function patchNote(filename, content, heading = null) {
  const { default: fetch } = await import('node-fetch')
  const { Agent } = await import('https')

  // If no heading specified, append to end of file
  const url = heading
    ? `${BASE()}/vault/${filename}`
    : `${BASE()}/vault/${filename}`

  // Use PATCH with insert-at-end by appending to the file content
  // Simpler: read current content, append, then PUT back
  const getResp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${KEY()}`,
      Accept: 'text/markdown',
    },
    agent: new Agent({ rejectUnauthorized: false }),
  })

  if (!getResp.ok && getResp.status !== 200) {
    throw new Error(`Could not read note for patching: ${getResp.status}`)
  }

  const existing = await getResp.text()
  const updated  = existing + content

  const putResp = await fetch(url, {
    method:  'PUT',
    headers: {
      Authorization:  `Bearer ${KEY()}`,
      'Content-Type': 'text/markdown',
    },
    body:  updated,
    agent: new Agent({ rejectUnauthorized: false }),
  })

  if (putResp.status === 200 || putResp.status === 204) {
    return { success: true, path: filename }
  }

  throw new Error(`Patch failed: ${putResp.status}`)
}

/**
 * Search the vault for notes matching a query.
 * Returns an array of vault-relative file paths.
 */
export async function searchVault(query) {
  const { default: fetch } = await import('node-fetch')
  const { Agent } = await import('https')

  const url = `${BASE()}/search/simple/?query=${encodeURIComponent(query)}`

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${KEY()}` },
    agent:   new Agent({ rejectUnauthorized: false }),
    signal:  AbortSignal.timeout(5000),
  })

  if (!resp.ok) return []

  const results = await resp.json()
  // Returns array of { filename, score, matches }
  return (results || [])
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .map(r => r.filename)
    .filter(Boolean)
}

/**
 * Read a note from the Obsidian vault.
 * Returns the markdown content as a string, or null if not found.
 */
export async function readNote(filename) {
  const { default: fetch } = await import('node-fetch')
  const { Agent } = await import('https')

  const url = `${BASE()}/vault/${filename}`

  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${KEY()}`,
      Accept: 'text/markdown',
    },
    agent: new Agent({ rejectUnauthorized: false }),
    signal: AbortSignal.timeout(5000),
  })

  if (resp.status === 404) return null
  if (!resp.ok) throw new Error(`Could not read note ${filename}: ${resp.status}`)

  return resp.text()
}
