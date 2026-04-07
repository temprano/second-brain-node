/**
 * notebooklm.js — NotebookLM connector
 * 
 * Bridges to NotebookLM via the notebooklm-py CLI tool.
 * This is the pragmatic approach for personal use — no Enterprise API needed.
 * 
 * SETUP (one time):
 *   pip install notebooklm-py
 *   notebooklm auth login   ← opens browser for Google sign-in
 * 
 * What this does in the pipeline:
 *   1. Creates a new notebook for the topic
 *   2. Uploads the Obsidian note as a source
 *   3. Generates a study guide (FAQ + key topics)
 *   4. Generates a quiz (can export for more Anki cards)
 *   5. Optionally generates an Audio Overview (podcast MP3)
 * 
 * NotebookLM API status (March 2026):
 *   - Enterprise API: available but requires Google Cloud project
 *   - Consumer/personal: no official API — notebooklm-py uses internal endpoints
 *   - notebooklm-py may break if Google changes internal APIs
 */

import { execSync, exec } from 'child_process'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { promisify } from 'util'
import { join } from 'path'

const execAsync = promisify(exec)
const CLI = process.env.NOTEBOOKLM_BRIDGE || 'notebooklm'

/**
 * Check if notebooklm-py CLI is installed and authenticated
 */
export async function checkNotebookLM() {
  try {
    await execAsync(`${CLI} --version`)
    return true
  } catch {
    return false
  }
}

/**
 * Run a notebooklm CLI command and return stdout
 */
async function nb(args) {
  const { stdout, stderr } = await execAsync(`${CLI} ${args}`, {
    timeout: 120_000,  // 2 min — some operations (audio) take longer
  })
  return stdout.trim()
}

/**
 * Full NotebookLM workflow for a research topic:
 * 1. Create notebook
 * 2. Upload note content as a source
 * 3. Generate study guide
 * 4. Generate quiz
 * 5. (Optional) Generate audio overview
 * 
 * Returns metadata about the created notebook
 */
export async function processWithNotebookLM(data, noteContent, options = {}) {
  const { generateAudio = false } = options
  const title = data.title || 'Research Note'
  const results = {}

  // 1. Create a new notebook for this topic
  const createOutput = await nb(`notebook create --title "${title}"`)
  // Parse notebook ID from output — format: "Created notebook: <ID>"
  const notebookMatch = createOutput.match(/notebook[:\s]+([a-zA-Z0-9_-]+)/i)
  const notebookId = notebookMatch?.[1]

  if (!notebookId) {
    throw new Error(`Could not parse notebook ID from: ${createOutput}`)
  }

  results.notebookId = notebookId

  // 2. Upload the note content as a source
  // Write to temp file first — notebooklm-py accepts file paths
  const tmpDir = './tmp_pipeline'
  mkdirSync(tmpDir, { recursive: true })
  const tmpFile = join(tmpDir, `${data.topic_tag}-source.md`)
  writeFileSync(tmpFile, noteContent, 'utf8')

  await nb(`source add --notebook ${notebookId} --file "${tmpFile}"`)

  // 3. Generate study guide (FAQ format — great for overview)
  const studyGuide = await nb(`generate study-guide --notebook ${notebookId} --wait`)
  results.studyGuide = studyGuide

  // 4. Generate quiz (multiple choice questions)
  const quiz = await nb(`generate quiz --notebook ${notebookId} --difficulty medium --wait`)
  results.quiz = quiz

  // 5. Optional: generate audio overview podcast
  if (generateAudio) {
    await nb(`generate audio --notebook ${notebookId} --wait`)
    const audioPath = join(tmpDir, `${data.topic_tag}-audio-overview.mp3`)
    try {
      await nb(`download audio --notebook ${notebookId} --output "${audioPath}"`)
      results.audioPath = audioPath
    } catch {
      results.audioNote = 'Audio generated in NotebookLM — download manually from the web UI'
    }
  }

  results.notebookUrl = `https://notebooklm.google.com/notebook/${notebookId}`

  return results
}

/**
 * Extract additional Anki cards from the NotebookLM quiz output.
 * Converts multiple-choice questions into Basic Anki cards.
 */
export function extractCardsFromQuiz(quizText, deckName, topicTag) {
  const cards = []
  const lines = quizText.split('\n')
  
  let currentQuestion = null

  for (const line of lines) {
    const trimmed = line.trim()
    
    // Look for question lines (numbered or starting with Q:)
    if (/^\d+[\.\)]\s/.test(trimmed) || trimmed.startsWith('Q:')) {
      currentQuestion = trimmed.replace(/^\d+[\.\)]\s/, '').replace(/^Q:\s*/, '')
    }
    
    // Look for answer lines (A:, Answer:, Correct:)
    if (currentQuestion && /^(A:|Answer:|Correct:)/i.test(trimmed)) {
      const answer = trimmed.replace(/^(A:|Answer:|Correct:)\s*/i, '')
      cards.push({
        type: 'basic',
        front: currentQuestion,
        back: answer,
        source: 'notebooklm-quiz',
      })
      currentQuestion = null
    }
  }

  return cards
}
