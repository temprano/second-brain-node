/**
 * search.js — Provider-agnostic web search module
 *
 * Decouples web search from the LLM provider so any model (including Kimi
 * on NVIDIA NIM) can do research — the search results are fetched here and
 * passed as context into the LLM prompt.
 *
 * Supported search providers:
 *   serper   — serper.dev  — fastest, cheapest, Google only
 *              Free: 2,500 queries. Get key: serper.dev/api-key
 *
 *   serpapi  — serpapi.com — multi-engine (Google, Bing, Yahoo, etc.)
 *              Free: 250/month. Get key: serpapi.com/manage-api-key
 *
 *   brave    — brave.com/search/api — independent index, privacy-focused
 *              Free: 2,000/month. Get key: brave.com/search/api
 *
 * Set in .env:
 *   SEARCH_PROVIDER=serper          (serper | serpapi | brave)
 *   SERPER_API_KEY=...
 *   SERPAPI_KEY=...
 *   BRAVE_SEARCH_API_KEY=...
 */

// ── Serper ─────────────────────────────────────────────────────────────────
// serper.dev — Google Search API, ~1-2s response, real-time results
// Returns: organic results, knowledge graph, people-also-ask, related searches

async function searchSerper(query, numResults = 8) {
  const response = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'X-API-KEY': process.env.SERPER_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      q: query,
      num: numResults,
      gl: 'us',
      hl: 'en',
    }),
  })

  if (!response.ok) {
    throw new Error(`Serper API error ${response.status}: ${await response.text()}`)
  }

  const data = await response.json()

  // Normalise to our common format
  const results = []

  // Organic results
  for (const r of data.organic || []) {
    results.push({
      title:   r.title,
      url:     r.link,
      snippet: r.snippet,
      source:  'organic',
    })
  }

  // Knowledge graph (authoritative summary)
  if (data.knowledgeGraph) {
    const kg = data.knowledgeGraph
    results.unshift({
      title:   kg.title,
      url:     kg.website || '',
      snippet: kg.description || kg.descriptionSource || '',
      source:  'knowledge-graph',
    })
  }

  // People also ask — great for generating Anki questions
  const paa = (data.peopleAlsoAsk || []).slice(0, 4).map(q => ({
    title:   q.question,
    url:     q.link || '',
    snippet: q.snippet || '',
    source:  'people-also-ask',
  }))

  return [...results, ...paa].slice(0, numResults + 4)
}

// ── SerpApi ────────────────────────────────────────────────────────────────
// serpapi.com — multi-engine, more expensive, widest coverage

async function searchSerpApi(query, numResults = 8) {
  const params = new URLSearchParams({
    engine:  'google',
    q:       query,
    api_key: process.env.SERPAPI_KEY,
    num:     numResults,
    hl:      'en',
    gl:      'us',
  })

  const response = await fetch(`https://serpapi.com/search?${params}`)

  if (!response.ok) {
    throw new Error(`SerpApi error ${response.status}: ${await response.text()}`)
  }

  const data = await response.json()

  return (data.organic_results || []).slice(0, numResults).map(r => ({
    title:   r.title,
    url:     r.link,
    snippet: r.snippet,
    source:  'organic',
  }))
}

// ── Brave Search ───────────────────────────────────────────────────────────
// brave.com/search/api — independent index, privacy-focused, 2,000 free/month

async function searchBrave(query, numResults = 8) {
  const params = new URLSearchParams({
    q:     query,
    count: numResults,
  })

  const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: {
      'Accept':             'application/json',
      'Accept-Encoding':    'gzip',
      'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY,
    },
  })

  if (!response.ok) {
    throw new Error(`Brave Search error ${response.status}: ${await response.text()}`)
  }

  const data = await response.json()

  return (data.web?.results || []).slice(0, numResults).map(r => ({
    title:   r.title,
    url:     r.url,
    snippet: r.description,
    source:  'organic',
  }))
}

// ── Main search function ───────────────────────────────────────────────────

/**
 * Search the web using whichever provider is configured in .env
 * Returns an array of { title, url, snippet, source } objects
 */
export async function search(query, numResults = 8) {
  const provider = (process.env.SEARCH_PROVIDER || 'serper').toLowerCase()

  switch (provider) {
    case 'serper':  return searchSerper(query, numResults)
    case 'serpapi': return searchSerpApi(query, numResults)
    case 'brave':   return searchBrave(query, numResults)
    default:
      throw new Error(
        `Unknown search provider: "${provider}".\n` +
        `Set SEARCH_PROVIDER to: serper | serpapi | brave`
      )
  }
}

/**
 * Run multiple searches in parallel and merge results.
 * Useful for multi-angle research (e.g. "topic basics" + "topic advanced" + "topic history")
 */
export async function multiSearch(queries, numPerQuery = 5) {
  const results = await Promise.all(queries.map(q => search(q, numPerQuery)))
  // Flatten and deduplicate by URL
  const seen = new Set()
  return results.flat().filter(r => {
    if (!r.url || seen.has(r.url)) return false
    seen.add(r.url)
    return true
  })
}

/**
 * Format search results into a readable context block for an LLM prompt.
 * Each result becomes a numbered entry with title, URL, and snippet.
 */
export function formatResultsForPrompt(results) {
  if (!results.length) return 'No search results found.'

  return results.map((r, i) => {
    const lines = [`[${i + 1}] ${r.title}`]
    if (r.url)     lines.push(`    URL: ${r.url}`)
    if (r.snippet) lines.push(`    ${r.snippet}`)
    return lines.join('\n')
  }).join('\n\n')
}

/**
 * Check if the configured search provider is available (key set in .env)
 */
export function checkSearchProvider() {
  const provider = (process.env.SEARCH_PROVIDER || 'serper').toLowerCase()
  const keyMap = {
    serper:  'SERPER_API_KEY',
    serpapi: 'SERPAPI_KEY',
    brave:   'BRAVE_SEARCH_API_KEY',
  }
  const key = keyMap[provider]
  const hasKey = key && !!process.env[key]

  return {
    provider,
    configured: hasKey,
    keyName: key,
    message: hasKey
      ? `✓ ${provider} search configured`
      : `✗ ${key} not set in .env — get free key at ${providerUrls[provider]}`,
  }
}

const providerUrls = {
  serper:  'serper.dev/api-key (2,500 free queries)',
  serpapi: 'serpapi.com/manage-api-key (250 free/month)',
  brave:   'brave.com/search/api (2,000 free/month)',
}
