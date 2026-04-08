/**
 * intent.js — Intent parser and router
 *
 * Parses commands from OpenClaw in the format:
 *   "research: best home owners insurance right now"
 *   "learning: Remotion full review"
 *   "study: quantum computing basics"
 *
 * The part before the colon = intent category
 * The part after  the colon = topic to research
 *
 * Each intent maps to:
 *   - An Obsidian vault folder (where the note is saved)
 *   - An Anki deck suffix   (which deck cards go into)
 *   - A search strategy     (how many queries, what angle)
 *   - A synthesis persona   (how the LLM frames its output)
 */

// ── Intent definitions ────────────────────────────────────────────────────────

const INTENTS = {
  // "research: best home owners insurance right now"
  // → factual, current, comparison-focused
  research: {
    label:        'Research',
    vaultFolder:  '100-Learning/Research',
    deckSuffix:   (topic) => `Research::${toTitleCase(topic)}`,
    searchAngles: (topic) => [
      topic,
      `${topic} comparison guide`,
      `${topic} expert recommendations ${new Date().getFullYear()}`,
    ],
    persona: `You are a rigorous research analyst. Your job is to synthesise
current web sources into clear, factual, comparable insights. Focus on:
- Key decision factors and tradeoffs
- Current best options with reasons
- What experts and reviewers agree on
- Common mistakes or misconceptions
- What to watch out for`,
    cardFocus: 'Focus cards on key criteria, comparisons, and decision factors.',
  },

  // "learning: Remotion full review"
  // → educational, skill-building, deep understanding
  learning: {
    label:        'Learning',
    vaultFolder:  '100-Learning/Topics',
    deckSuffix:   (topic) => `Learning::${toTitleCase(topic)}`,
    searchAngles: (topic) => [
      `${topic} tutorial explained`,
      `${topic} key concepts fundamentals`,
      `${topic} advanced techniques tips`,
    ],
    persona: `You are an expert educator and learning scientist. Your job is to
synthesise web sources into material optimised for deep understanding and
long-term retention. Focus on:
- The core mental model (what is this, really?)
- How it works under the hood
- Counterintuitive or surprising aspects
- Common beginner mistakes
- Connections to things the learner likely already knows`,
    cardFocus: 'Focus cards on core concepts, how-it-works, and surprising facts.',
  },

  // "study: stoic philosophy"
  // → academic, structured, exam-style
  study: {
    label:        'Study',
    vaultFolder:  '100-Learning/Study',
    deckSuffix:   (topic) => `Study::${toTitleCase(topic)}`,
    searchAngles: (topic) => [
      `${topic} overview`,
      `${topic} key terms definitions`,
      `${topic} important concepts`,
    ],
    persona: `You are an academic tutor preparing study material. Focus on:
- Precise definitions of key terms
- Dates, names, and facts worth memorising
- Cause-and-effect relationships
- Common exam questions on this topic`,
    cardFocus: 'Focus cards on definitions, key facts, and cause-effect relationships.',
  },

  // "review: make it stick book"
  // → book/product/tool reviews and summaries
  review: {
    label:        'Review',
    vaultFolder:  '100-Learning/Reviews',
    deckSuffix:   (topic) => `Reviews::${toTitleCase(topic)}`,
    searchAngles: (topic) => [
      `${topic} review`,
      `${topic} pros cons analysis`,
      `${topic} expert opinion`,
    ],
    persona: `You are a critical reviewer synthesising opinions and analysis.
Focus on:
- Core value proposition (what problem does this solve?)
- Strengths and genuine weaknesses
- Who it's best suited for
- Key takeaways and memorable insights
- Verdict / recommendation`,
    cardFocus: 'Focus cards on key insights, strengths/weaknesses, and memorable takeaways.',
  },

  // "news: AI regulation latest"
  // → current events, fast-moving topics
  news: {
    label:        'News',
    vaultFolder:  '100-Learning/News',
    deckSuffix:   (topic) => `News::${toTitleCase(topic)}`,
    searchAngles: (topic) => [
      `${topic} latest news`,
      `${topic} recent developments`,
      `${topic} ${new Date().getFullYear()}`,
    ],
    persona: `You are a news analyst. Summarise current developments clearly.
Focus on:
- What happened and when
- Why it matters
- Who the key players are
- What comes next / what to watch for`,
    cardFocus: 'Focus cards on key events, players, and implications.',
  },

  // "daily:" — generate today's daily note
  daily: {
    label:       'Daily Note',
    vaultFolder: '_daily',
    deckSuffix:  () => null,
    searchAngles: () => [],
    persona:     null,
    cardFocus:   null,
    isProductivity: true,
    productivityType: 'daily',
  },

  // "meeting: [paste raw notes here]" — process meeting notes
  meeting: {
    label:       'Meeting',
    vaultFolder: '_daily/meetings',
    deckSuffix:  () => null,
    searchAngles: () => [],
    persona:     null,
    cardFocus:   null,
    isProductivity: true,
    productivityType: 'meeting',
  },

  // "weekly:" — generate this week's review
  weekly: {
    label:       'Weekly Review',
    vaultFolder: '_daily/reviews',
    deckSuffix:  () => null,
    searchAngles: () => [],
    persona:     null,
    cardFocus:   null,
    isProductivity: true,
    productivityType: 'weekly',
  },

  // "augment: home insurance [paste article text here]"
  // → patches existing note with user-supplied content + new cards
  augment: {
    label:        'Augment',
    vaultFolder:  '100-Learning/Research',
    deckSuffix:   (topic) => toTitleCase(topic),
    searchAngles: () => [],   // no web search — user is the source
    persona:      null,
    cardFocus:    'Focus cards on the specific claims and insights in the provided text.',
    isAugment:    true,       // flag for the pipeline to route differently
  },

  // "source: [paste article text here]" — no topic prefix, just raw content
  source: {
    label:        'Source',
    vaultFolder:  '100-Learning/Research',
    deckSuffix:   (topic) => toTitleCase(topic),
    searchAngles: () => [],
    persona:      null,
    cardFocus:    'Focus cards on the key claims and evidence in this source.',
    isAugment:    true,
  },

  // "contract: [upload PDF]" — parse and evaluate contracts, policies, agreements
  contract: {
    label:        'Contract',
    vaultFolder:  '100-Learning/Contracts',
    deckSuffix:   () => null,
    searchAngles: () => [],
    persona:      null,
    cardFocus:    null,
    isContract:   true,
  },

  // "contract ask: <sessionId> | question" — follow-up Q&A on an analyzed document
  'contract ask': {
    label:        'Contract Q&A',
    vaultFolder:  null,
    deckSuffix:   () => null,
    searchAngles: () => [],
    persona:      null,
    cardFocus:    null,
    isContractQA: true,
  },
}

// Default fallback for unrecognised intents
const DEFAULT_INTENT = {
  label:        'General',
  vaultFolder:  '100-Learning/Research',
  deckSuffix:   (topic) => `Learning::${toTitleCase(topic)}`,
  searchAngles: (topic) => [topic, `${topic} explained`, `${topic} overview`],
  persona:      'You are an expert researcher and educator. Synthesise the search results into clear, useful knowledge.',
  cardFocus:    'Focus cards on the most important and memorable concepts.',
}

// ── Parser ────────────────────────────────────────────────────────────────────

/**
 * Parse a raw command string into structured intent + topic.
 *
 * Accepts:
 *   "research: best home owners insurance"
 *   "learning: Remotion"
 *   "study:quantum physics"      (space after colon optional)
 *   "just a topic with no intent" (defaults to 'research')
 *
 * Returns:
 *   { intent, intentKey, topic, vaultFolder, deckSuffix, searchAngles, persona, cardFocus }
 */
export function parseIntent(input) {
  const trimmed = input.trim()

  // Check for "intent: topic" pattern
  const colonIdx = trimmed.indexOf(':')

  if (colonIdx > 0 && colonIdx < 20) {
    const maybeIntent = trimmed.slice(0, colonIdx).trim().toLowerCase()
    const topic       = trimmed.slice(colonIdx + 1).trim()

    // Check for two-word intents like "contract ask"
    const twoWord = trimmed.slice(0, colonIdx).trim().toLowerCase()
    const spaceIdx = twoWord.lastIndexOf(' ')
    if (spaceIdx > 0 && INTENTS[twoWord]) {
      const intent = INTENTS[twoWord]
      const afterColon = trimmed.slice(colonIdx + 1).trim()

      if (intent.isContractQA) {
        // "contract ask: <sessionId> | question"
        const pipeIdx = afterColon.indexOf('|')
        const sessionId = pipeIdx > 0 ? afterColon.slice(0, pipeIdx).trim() : afterColon.trim()
        const question  = pipeIdx > 0 ? afterColon.slice(pipeIdx + 1).trim() : ''
        return {
          intentKey:     twoWord,
          intent:        intent.label,
          topic:         sessionId,
          sessionId,
          question,
          isContractQA:  true,
        }
      }
    }

    if (INTENTS[maybeIntent] && topic.length > 0) {
      const intent = INTENTS[maybeIntent]

      // Contract intents: route to contract analysis pipeline
      if (intent.isContract) {
        return {
          intentKey:    maybeIntent,
          intent:       intent.label,
          topic:        topic || 'Uploaded Document',
          vaultFolder:  intent.vaultFolder,
          isContract:   true,
        }
      }

      // Augment intents: "augment: topic name | article text here..."
      // Or:             "augment: topic name\n\narticle text here..."
      // Topic is before the | or first newline, rest is source text
      if (intent.isAugment) {
        const pipeIdx  = topic.indexOf('|')
        const nlIdx    = topic.indexOf('\n')
        const splitIdx = pipeIdx > 0 ? pipeIdx : nlIdx > 0 ? nlIdx : -1

        const actualTopic  = splitIdx > 0 ? topic.slice(0, splitIdx).trim() : topic
        const sourceText   = splitIdx > 0 ? topic.slice(splitIdx + 1).trim() : ''

        return {
          intentKey:    maybeIntent,
          intent:       intent.label,
          topic:        actualTopic,
          sourceText,
          vaultFolder:  intent.vaultFolder,
          deckSuffix:   intent.deckSuffix(actualTopic),
          searchAngles: [],
          persona:      intent.persona,
          cardFocus:    intent.cardFocus,
          isAugment:    true,
        }
      }

      return {
        intentKey:       maybeIntent,
        intent:          intent.label,
        topic,
        vaultFolder:     intent.vaultFolder,
        deckSuffix:      intent.deckSuffix ? intent.deckSuffix(topic) : null,
        searchAngles:    intent.searchAngles ? intent.searchAngles(topic) : [],
        persona:         intent.persona,
        cardFocus:       intent.cardFocus,
        isProductivity:  intent.isProductivity || false,
        productivityType: intent.productivityType || null,
      }
    }
  }

  // No recognised intent prefix — default to research
  const topic = trimmed
  return {
    intentKey:    'research',
    intent:       'Research',
    topic,
    vaultFolder:  DEFAULT_INTENT.vaultFolder,
    deckSuffix:   DEFAULT_INTENT.deckSuffix(topic),
    searchAngles: DEFAULT_INTENT.searchAngles(topic),
    persona:      DEFAULT_INTENT.persona,
    cardFocus:    DEFAULT_INTENT.cardFocus,
  }
}

/**
 * List all valid intent keywords (for help messages / validation)
 */
export function validIntents() {
  return Object.keys(INTENTS)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toTitleCase(str) {
  return str
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
    .slice(0, 40)  // cap deck name length
}
