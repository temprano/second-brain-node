/**
 * augment.js — Augmentation agent
 *
 * Processes user-supplied text (copied from paywalled articles, PDFs,
 * personal notes, transcripts, etc.) and merges it into an existing
 * Obsidian note, generating additional Anki cards from the new content.
 *
 * Two usage patterns:
 *
 * 1. PATCH an existing note (topic already researched):
 *    augment: home insurance [article text pasted here]
 *    → finds the existing note, appends new insights + cards under
 *      a "## From Your Sources" heading
 *
 * 2. CREATE a note from scratch from user-supplied text only:
 *    source: [article text pasted here]
 *    → creates a new note entirely from the pasted content,
 *      no web search needed
 *
 * The key difference from regular research:
 *   - No web search — the user IS the source
 *   - LLM reads the pasted text directly
 *   - Uses PATCH API to append to existing notes, not overwrite them
 */

import { researchModel } from '../providers/llm.js'
import { patchNote, searchVault, writeNote } from '../connectors/obsidian.js'
import { pushCardsToAnki, syncToAnkiWeb } from '../connectors/anki.js'

// ── System prompts ────────────────────────────────────────────────────────────

const AUGMENT_SYSTEM = `You are a learning synthesis expert. The user has provided
text from a source they have personally read — it may be from a paywalled article,
a book, a PDF, a transcript, or their own notes.

Your job is to:
1. Extract the key insights, facts, and arguments from the provided text
2. Identify what is NEW compared to what might already be known on this topic
3. Highlight any counterintuitive or surprising findings
4. Generate high-quality Anki flashcards from this specific source
5. Write a brief summary of what this source contributes

Do NOT add information from your training data. Work ONLY with what is in the
provided text. If the text is incomplete or truncated, say so in the summary.`

const AUGMENT_PROMPT = (topic, sourceText, cardsPerTopic) => `
Topic this relates to: "${topic}"

Source text provided by the user:
─────────────────────────────────────────────────────────────
${sourceText.slice(0, 12000)}${sourceText.length > 12000 ? '\n[... text truncated at 12,000 chars]' : ''}
─────────────────────────────────────────────────────────────

Return a JSON object with this structure:
{
  "source_summary": "2-3 sentences: what does this source contribute? What's the key argument or finding?",
  "new_insights": [
    "Specific insight from this source — quote or paraphrase the key point"
  ],
  "surprising_facts": [
    "Counterintuitive finding from this source"
  ],
  "author_perspective": "What angle or bias does this source bring? Who wrote it and why?",
  "conflicts_with": "Any claims in this source that might conflict with mainstream understanding",
  "flashcards": [
    {
      "type": "basic",
      "front": "Question based on this specific source",
      "back": "Answer drawn from the source text",
      "source_note": "Brief note about where this came from"
    },
    {
      "type": "cloze",
      "text": "Sentence with {{c1::key term}} from the source blanked out"
    }
  ]
}

Generate ${cardsPerTopic} flashcards. These should be based ONLY on the provided text.
Tag them mentally as coming from a user-supplied source.`

// ── Main augment function ─────────────────────────────────────────────────────

/**
 * Process user-supplied text and patch it into an existing Obsidian note.
 *
 * @param {string} topic      - The topic this content relates to
 * @param {string} sourceText - The article/PDF text pasted by the user
 * @param {object} opts       - { sourceName, deckSuffix, vaultFolder, createIfMissing }
 * @returns {object}          - Result summary
 */
export async function augmentTopic(topic, sourceText, opts = {}) {
  const {
    sourceName      = 'User-supplied source',
    deckSuffix      = null,
    vaultFolder     = '100-Learning/Research',
    createIfMissing = true,
  } = opts

  const cardsPerTopic = Math.max(4, parseInt(process.env.CARDS_PER_TOPIC || '8') - 2)

  if (!sourceText || sourceText.trim().length < 100) {
    throw new Error('Source text is too short — paste at least a paragraph of content')
  }

  // ── Step 1: Extract insights from user text ───────────────────────────────
  const model = researchModel()
  const extracted = await model.completeJSON({
    system: AUGMENT_SYSTEM,
    prompt: AUGMENT_PROMPT(topic, sourceText, cardsPerTopic),
  })

  if (!extracted.flashcards || !Array.isArray(extracted.flashcards)) {
    throw new Error('Augment agent returned malformed data')
  }

  // ── Step 2: Find the existing note in Obsidian ────────────────────────────
  let existingNotePath = null
  try {
    const searchResults = await searchVault(topic)
    // Find the closest matching note
    existingNotePath = searchResults.find(r =>
      r.toLowerCase().includes(topic.toLowerCase().slice(0, 20))
    ) || searchResults[0]
  } catch {
    // Search failed — will create new note if createIfMissing is true
  }

  // ── Step 3: Build the patch content ──────────────────────────────────────
  const today      = new Date().toISOString().split('T')[0]
  const prefix     = process.env.ANKI_DECK_PREFIX || 'Learning'
  const deck       = deckSuffix ? `${prefix}::${deckSuffix}` : `${prefix}::${toTitleCase(topic)}`
  const topicTag   = topic.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '').slice(0, 30)

  // Build the new section to append
  const cardsMd = extracted.flashcards.map(card => {
    if (card.type === 'basic') {
      return `START
Basic
Deck: ${deck}
Tags: ${topicTag}, user-source, augmented
${card.front}
Back: ${card.back}
END`
    } else {
      return `START
Cloze
Deck: ${deck}
Tags: ${topicTag}, user-source, augmented
${card.text}
END`
    }
  }).join('\n\n')

  const insightsMd = (extracted.new_insights || [])
    .map(i => `- ${i}`)
    .join('\n') || '- See source summary above'

  const surprisingMd = (extracted.surprising_facts || [])
    .map(f => `- ${f}`)
    .join('\n') || ''

  const newSection = `

---

## 📎 From Your Sources — ${sourceName}
*Added: ${today}*

### Summary
${extracted.source_summary || ''}

### New Insights
${insightsMd}

${surprisingMd ? `### Surprising Points\n${surprisingMd}\n` : ''}
${extracted.conflicts_with ? `### Conflicts With Mainstream View\n${extracted.conflicts_with}\n` : ''}
${extracted.author_perspective ? `### Author Perspective\n${extracted.author_perspective}\n` : ''}

### 🃏 Cards From This Source

${cardsMd}
`

  // ── Step 4: Write to Obsidian ─────────────────────────────────────────────
  let notePath
  let writeMode

  if (existingNotePath) {
    // PATCH the existing note — append under a new heading
    notePath  = existingNotePath
    writeMode = 'patch'
    await patchNote(existingNotePath, newSection)
  } else if (createIfMissing) {
    // Create a stub note for this topic with just the augmented content
    notePath  = `${vaultFolder}/${toTitleCase(topic)} (from source).md`
    writeMode = 'create'
    const stubNote = `---
type: research
topic: ${topicTag}
tags: [${topicTag}, user-source, augmented]
source: "${sourceName}"
created: ${today}
deck: "${deck}"
---

# ${toTitleCase(topic)}

> 📎 *This note was created from user-supplied source material.*
> Run \`research: ${topic}\` to add web research to this note.
${newSection}`
    await writeNote(notePath, stubNote)
  } else {
    throw new Error(`No existing note found for "${topic}" and createIfMissing is false`)
  }

  // ── Step 5: Push cards to Anki ────────────────────────────────────────────
  // Build a minimal data object compatible with pushCardsToAnki
  const ankiData = {
    deck_suffix: deckSuffix || toTitleCase(topic),
    topic_tag:   topicTag,
    flashcards:  extracted.flashcards,
  }

  let ankiResult = { added: 0, skipped: 0, deck }
  try {
    ankiResult = await pushCardsToAnki(ankiData)
    if (process.env.AUTO_SYNC_ANKI !== 'false') {
      await syncToAnkiWeb().catch(() => null)
    }
  } catch {
    // Non-fatal — note is saved even if Anki push fails
  }

  return {
    notePath,
    writeMode,
    deck,
    cardsAdded:    ankiResult.added,
    cardsSkipped:  ankiResult.skipped,
    insightsFound: (extracted.new_insights || []).length,
    sourceSummary: extracted.source_summary,
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toTitleCase(str) {
  return str
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
    .slice(0, 50)
}
