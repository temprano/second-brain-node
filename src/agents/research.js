/**
 * research.js — Research agent
 *
 * Fetches web search results via search.js (Serper / SerpApi / Brave),
 * then passes them as context to ANY configured LLM for synthesis.
 * This makes the research stage fully provider-agnostic — Kimi, Claude,
 * GPT, Gemini — any model can now do research without needing built-in
 * web search capability.
 */

import { researchModel, synthesisModel } from '../providers/llm.js'
import { multiSearch, formatResultsForPrompt } from '../providers/search.js'

const SYNTHESIS_SYSTEM = `You are an expert research synthesiser and learning scientist.
You are given web search results about a topic. Your job is to:
1. Extract the most important concepts from the search results
2. Identify counterintuitive or surprising facts (these make the best Anki cards)
3. Spot common misconceptions worth correcting
4. Find connections to adjacent topics the learner may already know
5. Generate high-quality spaced repetition flashcards

Base your response ONLY on the provided search results. Do not invent facts.`

const SYNTHESIS_PROMPT = (topic, searchContext, cardsPerTopic, cardFocus = null) => `
Topic: "${topic}"

Web search results:
─────────────────────────────────────────────
${searchContext}
─────────────────────────────────────────────

Based on these search results, return a JSON object with this exact structure:
{
  "title": "Clean descriptive title for the note",
  "topic_tag": "single-hyphenated-tag",
  "deck_suffix": "Human Readable Deck Name",
  "summary": "2-3 sentence overview. What is this and why does it matter?",
  "key_concepts": [
    {
      "concept": "Concept name",
      "explanation": "1-2 sentence explanation",
      "why_it_matters": "Why a learner should care"
    }
  ],
  "surprising_facts": [
    "Counterintuitive fact — these make the best Anki cards"
  ],
  "common_misconceptions": [
    "Misconception people commonly have about this topic"
  ],
  "connections": ["Related topic 1", "Related topic 2"],
  "sources": ["Source title — URL"],
  "flashcards": [
    {
      "type": "basic",
      "front": "Clear question — one concept only",
      "back": "Direct answer — max 2 sentences, no padding"
    },
    {
      "type": "cloze",
      "text": "Sentence with {{c1::key term}} blanked out"
    }
  ]
}

Generate exactly ${cardsPerTopic} flashcards. Mix basic Q&A and cloze 60/40.
${cardFocus || 'Prioritise cards for concepts that are easy to confuse, surprising facts, precise definitions, and cause-effect relationships.'}`

export async function researchTopic(topic, intentContext = {}) {
  const cardsPerTopic = parseInt(process.env.CARDS_PER_TOPIC || '8')
  const { searchAngles = null, persona = null, cardFocus = null } = intentContext

  // ── Stage 1: Web search ───────────────────────────────────────────────
  // Use intent-specific search angles if provided, else use defaults
  const queries = searchAngles || [
    topic,
    `${topic} explained in depth`,
    `${topic} key concepts fundamentals`,
  ]
  const searchResults = await multiSearch(queries, 5)

  if (!searchResults.length) {
    throw new Error(`No search results returned for "${topic}". Check your SEARCH_PROVIDER and API key.`)
  }

  const searchContext = formatResultsForPrompt(searchResults)

  // ── Stage 2: Synthesis (any LLM — including Kimi) ─────────────────────
  // Use intent persona if provided, else use default system prompt
  const systemPrompt = persona
    ? `${persona}

Base your response ONLY on the provided search results.`
    : SYNTHESIS_SYSTEM

  const model = researchModel()
  const data = await model.completeJSON({
    system: systemPrompt,
    prompt: SYNTHESIS_PROMPT(topic, searchContext, cardsPerTopic, cardFocus),
  })

  if (!data.flashcards || !Array.isArray(data.flashcards)) {
    throw new Error('Research agent returned malformed data — missing flashcards array')
  }

  // Attach raw sources for the Obsidian note
  data.sources = [
    ...(data.sources || []),
    ...searchResults
      .filter(r => r.url)
      .map(r => `${r.title} — ${r.url}`)
  ].slice(0, 10)

  return data
}

/**
 * Optional second pass: use a (potentially different) model to review
 * and improve the generated flashcards for spaced repetition quality.
 */
export async function reviewCards(data) {
  const model = synthesisModel()

  const improved = await model.completeJSON({
    system: 'You are a spaced repetition expert. Review and improve Anki flashcards for maximum recall effectiveness.',
    prompt: `Review these flashcards for "${data.title}" and return an improved version.

Rules for great cards:
- One atomic concept per card — never two ideas combined
- Front = question a tutor would ask
- Back = minimum viable answer, strip all padding
- Cloze: blank the most important term, not a random word
- Fix any card that combines ideas or has a vague question

Current cards:
${JSON.stringify(data.flashcards, null, 2)}

Return ONLY the improved flashcards array as JSON:
[{ "type": "basic|cloze", "front": "...", "back": "...", "text": "..." }]`
  })

  if (Array.isArray(improved)) {
    data.flashcards = improved
  }

  return data
}

