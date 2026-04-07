/**
 * anki.js — AnkiConnect connector
 * 
 * Pushes cards and decks directly into Anki via the AnkiConnect HTTP API.
 * Anki must be running with AnkiConnect installed (addon code: 2055492159).
 */

const ANKI_HOST = () => process.env.ANKI_HOST || 'http://localhost:8765'

/**
 * Core AnkiConnect request
 */
async function ankiRequest(action, params = {}) {
  const { default: fetch } = await import('node-fetch')
  const response = await fetch(ANKI_HOST(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, version: 6, params }),
    signal: AbortSignal.timeout(10_000),
  })

  const result = await response.json()

  if (result.error) {
    throw new Error(`AnkiConnect [${action}]: ${result.error}`)
  }

  return result.result
}

/**
 * Check if AnkiConnect is reachable
 */
export async function checkAnki() {
  try {
    const version = await ankiRequest('version')
    return { ok: true, version }
  } catch {
    return { ok: false }
  }
}

/**
 * Ensure a deck exists — creates it if not
 */
export async function ensureDeck(deckName) {
  await ankiRequest('createDeck', { deck: deckName })
}

/**
 * Add a single Basic card to Anki.
 * Returns the card ID, or null if duplicate.
 */
export async function addBasicCard({ deck, front, back, tags = [] }) {
  try {
    const id = await ankiRequest('addNote', {
      note: {
        deckName: deck,
        modelName: 'Basic',
        fields: { Front: front, Back: back },
        tags,
        options: { allowDuplicate: false },
      },
    })
    return id
  } catch (err) {
    if (err.message.includes('duplicate')) return null
    throw err
  }
}

/**
 * Add a single Cloze card to Anki.
 * Returns the card ID, or null if duplicate.
 */
export async function addClozeCard({ deck, text, tags = [] }) {
  try {
    const id = await ankiRequest('addNote', {
      note: {
        deckName: deck,
        modelName: 'Cloze',
        fields: { Text: text },
        tags,
        options: { allowDuplicate: false },
      },
    })
    return id
  } catch (err) {
    if (err.message.includes('duplicate')) return null
    throw err
  }
}

/**
 * Push all flashcards from research data to Anki.
 * Auto-creates the deck. Returns count of cards added.
 */
export async function pushCardsToAnki(data) {
  const deckPrefix = process.env.ANKI_DECK_PREFIX || 'Learning'
  const deck = `${deckPrefix}::${data.deck_suffix}`
  const tag = data.topic_tag
  const tags = [tag, 'pipeline-generated']

  // Ensure deck exists
  await ensureDeck(deck)

  let added = 0
  let skipped = 0

  for (const card of data.flashcards || []) {
    try {
      let id = null

      if (card.type === 'basic') {
        id = await addBasicCard({ deck, front: card.front, back: card.back, tags })
      } else if (card.type === 'cloze') {
        id = await addClozeCard({ deck, text: card.text, tags })
      }

      if (id) added++
      else skipped++

    } catch (err) {
      // Non-fatal: log and continue
      console.warn(`  Card skipped: ${err.message}`)
      skipped++
    }
  }

  return { deck, added, skipped }
}

/**
 * Trigger Anki to sync with AnkiWeb.
 * Requires user to be logged in to AnkiWeb in Anki.
 */
export async function syncToAnkiWeb() {
  await ankiRequest('sync')
}
