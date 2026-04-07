/**
 * run.js — Second Brain Pipeline orchestrator
 *
 * CLI usage:
 *   node src/pipeline/run.js "research: best home owners insurance"
 *   node src/pipeline/run.js "learning: Remotion full review"
 *   node src/pipeline/run.js "study: stoic philosophy" --review
 *   node src/pipeline/run.js "quantum computing"   (no prefix = research)
 *
 * Flags:
 *   --audio          Generate NotebookLM audio overview
 *   --review         Second AI pass to improve flashcard quality
 *   --no-notebooklm  Skip NotebookLM
 *   --no-anki        Skip Anki push
 *
 * Also exports runPipelineWithIntent() for the webhook server.
 */

import 'dotenv/config'
import { researchTopic, reviewCards } from '../agents/research.js'
import { buildNote, writeNote, checkObsidian } from '../connectors/obsidian.js'
import { pushCardsToAnki, syncToAnkiWeb, checkAnki } from '../connectors/anki.js'
import { checkNotebookLM, processWithNotebookLM, extractCardsFromQuiz } from '../connectors/notebooklm.js'
import { checkSearchProvider } from '../providers/search.js'
import { parseIntent } from './intent.js'
import { augmentTopic } from '../agents/augment.js'
import {
  generateDailyNote, processMeetingNote, generateWeeklyReview,
  fetchThisWeekNotes, fetchYesterdayOpenTasks
} from '../agents/productivity.js'

// ── Colours ───────────────────────────────────────────────────────────────────
const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', purple: '\x1b[35m',
  teal: '\x1b[36m', green: '\x1b[32m', amber: '\x1b[33m', dim: '\x1b[2m',
}
const log     = (m) => console.log(`${c.teal}${m}${c.reset}`)
const ok      = (m) => console.log(`${c.green}  ✓ ${m}${c.reset}`)
const warn    = (m) => console.log(`${c.amber}  ⚠ ${m}${c.reset}`)
const section = (m) => console.log(`\n${c.bold}${c.purple}── ${m} ──${c.reset}`)
const divider = ()  => console.log(`${c.dim}${'─'.repeat(52)}${c.reset}`)

// ── Pre-flight ────────────────────────────────────────────────────────────────
async function preflight(skipAnki, skipNotebookLM) {
  section('Pre-flight checks')

  const search = checkSearchProvider()
  search.configured ? ok(search.message) : warn(search.message)

  const obsidianOk = await checkObsidian()
  obsidianOk ? ok('Obsidian reachable') : warn('Obsidian not reachable — local fallback')

  if (!skipAnki) {
    const anki = await checkAnki()
    anki.ok ? ok(`Anki running (v${anki.version})`) : warn('Anki not running')
  }

  const useNotebookLM = process.env.NOTEBOOKLM_ENABLED === 'true' && !skipNotebookLM
  if (useNotebookLM) {
    const nlm = await checkNotebookLM()
    nlm ? ok('notebooklm-py found') : warn('notebooklm-py missing — pip install notebooklm-py')
  }

  return { obsidianOk, useNotebookLM }
}

// ── Core pipeline ─────────────────────────────────────────────────────────────

/**
 * Run the full pipeline for a parsed intent.
 * Exported for use by server.js (webhook) and called directly by CLI.
 */
export async function runPipelineWithIntent(parsed, flags = {}) {
  const {
    intent      = 'Research',
    topic,
    vaultFolder = process.env.OBSIDIAN_VAULT_PATH || '100-Learning/Research',
    deckSuffix  = null,
    searchAngles = null,
    persona     = null,
    cardFocus   = null,
  } = parsed

  const {
    generateAudio = false,
    doReview      = false,
    skipAnki      = false,
    useNotebookLM = false,
  } = flags

  console.log(`\n${c.bold}${c.purple}${'═'.repeat(52)}${c.reset}`)
  console.log(`${c.bold}  Intent: ${intent}  |  Topic: ${topic}${c.reset}`)
  console.log(`${c.bold}  Folder: ${vaultFolder}${c.reset}`)
  console.log(`${c.bold}${c.purple}${'═'.repeat(52)}${c.reset}`)

  // ── Productivity route — daily/meeting/weekly ────────────────────────────
  if (parsed.isProductivity) {
    section(`Stage 1 · ${intent}`)

    let result
    let filename

    if (parsed.productivityType === 'daily') {
      log('Fetching open tasks from yesterday...')
      const openTasks   = await fetchYesterdayOpenTasks()
      log(`Found ${openTasks.length} open tasks`)

      result   = await generateDailyNote({ existingTasks: openTasks })
      filename = result.filename
      ok(`Daily note created: ${filename}`)
      ok(`Carried over ${result.tasksCarried} open tasks`)

    } else if (parsed.productivityType === 'meeting') {
      const rawNotes = parsed.topic
      if (!rawNotes || rawNotes.trim().length < 30) {
        warn('No meeting notes found — paste your raw notes after "meeting:"')
        warn('Example: meeting: Joe said we need to finish API by Friday. Sarah will review docs.')
        return { title: 'Meeting', note: null, deck: null, cards: 0, newCards: 0 }
      }
      log('Processing meeting notes...')
      result   = await processMeetingNote(rawNotes)
      filename = result.filename
      ok(`Meeting note created: ${filename}`)
      ok(`${result.actionItems} action items extracted`)
      if (result.summary) log(`Summary: ${result.summary.slice(0, 100)}...`)

    } else if (parsed.productivityType === 'weekly') {
      log('Fetching this week\'s daily notes...')
      const weekNotes = await fetchThisWeekNotes()
      log(`Fetched notes from vault`)

      result   = await generateWeeklyReview({ weekNotes })
      filename = result.filename
      ok(`Weekly review created: ${filename}`)
      ok(`${result.highlights.length} highlights, ${result.priorities.length} priorities for next week`)
    }

    section('Complete')
    divider()
    console.log(`  ${c.bold}Intent:${c.reset}  ${intent}`)
    console.log(`  ${c.bold}Note:${c.reset}    ${filename}`)
    divider()
    console.log(`
${c.green}${c.bold}Done!${c.reset} Open Obsidian to review.
`)

    return { title: intent, note: filename, deck: null, cards: 0, newCards: 0 }
  }

  // Stage 1 — Research
  section(`Stage 1 · Research [${intent}]`)
  log(`"${topic}" via ${process.env.MODEL_RESEARCH || 'anthropic:claude-sonnet-4-6'}`)

  let data = await researchTopic(topic, { searchAngles, persona, cardFocus })
  if (deckSuffix) data.deck_suffix = deckSuffix
  ok(`${data.flashcards.length} cards · ${data.key_concepts.length} concepts`)

  if (doReview) {
    log('Running card review pass...')
    data = await reviewCards(data)
    ok('Cards improved')
  }

  // Stage 2 — Obsidian
  section('Stage 2 · Obsidian')
  const safeTitle   = data.title.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, ' ')
  const filename    = `${vaultFolder}/${safeTitle}.md`
  const noteContent = buildNote(data, topic)
  const wr          = await writeNote(filename, noteContent)
  wr.success ? ok(`Note: ${filename}`) : warn(`Local fallback: ${wr.path}`)

  // Stage 3 — NotebookLM
  let nlmResults = null
  section('Stage 3 · NotebookLM')
  if (useNotebookLM) {
    try {
      nlmResults = await processWithNotebookLM(data, noteContent, { generateAudio })
      ok(`Notebook created: ${nlmResults.notebookId}`)
      if (nlmResults.quiz) {
        const extra = extractCardsFromQuiz(nlmResults.quiz, data.deck_suffix, data.topic_tag)
        if (extra.length) { data.flashcards.push(...extra); ok(`+${extra.length} quiz cards`) }
      }
      if (generateAudio) {
        nlmResults.audioPath ? ok(`Audio: ${nlmResults.audioPath}`) : warn(`Audio at: ${nlmResults.notebookUrl}`)
      }
    } catch (e) { warn(`NotebookLM failed: ${e.message}`) }
  } else {
    log('Skipped (NOTEBOOKLM_ENABLED=false)')
  }

  // Stage 4 — Anki
  section('Stage 4 · Anki')
  let ankiResult = { added: 0, skipped: 0, deck: data.deck_suffix }
  if (!skipAnki) {
    try {
      ankiResult = await pushCardsToAnki(data)
      ok(`${ankiResult.deck}: +${ankiResult.added} cards (${ankiResult.skipped} dupes skipped)`)
      if (process.env.AUTO_SYNC_ANKI !== 'false') {
        try { await syncToAnkiWeb(); ok('Synced to AnkiWeb') }
        catch { warn('AnkiWeb sync skipped — sync manually') }
      }
    } catch (e) {
      warn(e.code === 'ECONNREFUSED' ? 'Anki not running' : `Anki error: ${e.message}`)
    }
  } else { log('Skipped (--no-anki)') }

  // Summary
  section('Complete')
  divider()
  console.log(`  ${c.bold}Intent:${c.reset}  ${intent}`)
  console.log(`  ${c.bold}Title:${c.reset}   ${data.title}`)
  console.log(`  ${c.bold}Note:${c.reset}    ${filename}`)
  console.log(`  ${c.bold}Deck:${c.reset}    ${ankiResult.deck}`)
  console.log(`  ${c.bold}Cards:${c.reset}   ${ankiResult.added} new / ${data.flashcards.length} total`)
  if (nlmResults?.notebookUrl) console.log(`  ${c.bold}NLM:${c.reset}     ${nlmResults.notebookUrl}`)
  divider()
  console.log(`\n${c.green}${c.bold}Done!${c.reset}\n`)

  return { title: data.title, note: filename, deck: ankiResult.deck, cards: ankiResult.added }
}

// ── CLI entry point ───────────────────────────────────────────────────────────
const isMain = process.argv[1]?.includes('run.js')

if (isMain) {
  const argv  = process.argv.slice(2)
  const flags = new Set(argv.filter(a => a.startsWith('--')))
  const raw   = argv.filter(a => !a.startsWith('--')).join(' ')

  if (!raw) {
    console.log(`\nUsage: node src/pipeline/run.js "<intent>: <topic>" [flags]`)
    console.log(`\nExamples:`)
    console.log(`  node src/pipeline/run.js "research: best home owners insurance"`)
    console.log(`  node src/pipeline/run.js "learning: Remotion full review"`)
    console.log(`  node src/pipeline/run.js "study: stoic philosophy" --review`)
    console.log(`  node src/pipeline/run.js "review: Make It Stick book" --audio`)
    console.log(`  node src/pipeline/run.js "quantum computing"   # no prefix = research`)
    console.log(`\nFlags: --audio  --review  --no-notebooklm  --no-anki`)
    process.exit(1)
  }

  const parsed = parseIntent(raw)
  const { useNotebookLM } = await preflight(flags.has('--no-anki'), flags.has('--no-notebooklm'))

  await runPipelineWithIntent(parsed, {
    generateAudio: flags.has('--audio'),
    doReview:      flags.has('--review'),
    skipAnki:      flags.has('--no-anki'),
    useNotebookLM,
  })
}
