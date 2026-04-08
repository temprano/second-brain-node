/**
 * contract.js — Contract & legal document analysis agent
 *
 * Parses and evaluates contracts, insurance policies, user agreements,
 * lease agreements, NDAs, terms of service, etc. uploaded as PDF.
 *
 * Two capabilities:
 *   1. ANALYZE — full document breakdown with outline, key terms, risks,
 *      obligations, deadlines, and plain-language summary
 *   2. ASK    — follow-up Q&A grounded ONLY in the document contents;
 *      answers cite specific sections/clauses
 *
 * Designed for OpenClaw / Telegram bot integration:
 *   - Upload a PDF → get a structured analysis back
 *   - Ask questions → answers drawn exclusively from the document
 */

import { synthesisModel } from '../providers/llm.js'

// ── System prompts ────────────────────────────────────────────────────────────

const ANALYSIS_SYSTEM = `You are an expert legal document analyst. The user has
uploaded a contract, insurance policy, user agreement, lease, NDA, terms of service,
or similar legal/business document.

Your job is to:
1. Identify the type of document and parties involved
2. Provide a structured outline of the full document
3. Extract ALL key terms, obligations, rights, and conditions
4. Flag any unusual, risky, or potentially unfavorable clauses
5. Identify important dates, deadlines, and renewal terms
6. Summarise financial terms (costs, penalties, fees, limits)
7. Rate overall risk/fairness from the reader's perspective
8. Provide a plain-language summary a non-lawyer can understand

Work ONLY with the text provided. Do NOT add legal advice from your training data.
If sections appear missing or truncated, note that explicitly.
Be thorough — the user depends on this analysis to understand their obligations.`

const ANALYSIS_PROMPT = (documentText, documentName) => `
Document: "${documentName}"

Full document text:
═══════════════════════════════════════════════════════════════
${documentText}
═══════════════════════════════════════════════════════════════

Analyze this document and return a JSON object with this structure:
{
  "document_type": "e.g. Insurance Policy, Lease Agreement, Terms of Service, NDA, Employment Contract",
  "parties": [
    { "role": "e.g. Insurer, Landlord, Service Provider", "name": "Party name from document" }
  ],
  "effective_date": "Date or null if not found",
  "expiration_date": "Date or null if not found",
  "outline": [
    {
      "section": "Section title or number",
      "summary": "1-2 sentence summary of what this section covers"
    }
  ],
  "key_terms": [
    {
      "term": "Name of the term or clause",
      "details": "What it means in plain language",
      "section_ref": "Where in the document this appears"
    }
  ],
  "obligations": [
    {
      "party": "Who has this obligation",
      "obligation": "What they must do",
      "deadline": "When, if specified",
      "consequence": "What happens if not met"
    }
  ],
  "financial_terms": [
    {
      "item": "e.g. Premium, Rent, Fee, Penalty, Deductible",
      "amount": "Dollar amount or formula",
      "frequency": "e.g. Monthly, Annual, One-time",
      "conditions": "Any conditions or triggers"
    }
  ],
  "important_dates": [
    {
      "date": "The date",
      "significance": "What happens on this date"
    }
  ],
  "risk_flags": [
    {
      "clause": "The concerning clause or term",
      "risk": "Why this is potentially risky or unfavorable",
      "severity": "high | medium | low",
      "section_ref": "Where in the document"
    }
  ],
  "coverage_or_rights": [
    {
      "item": "What is covered / what right you have",
      "details": "Specifics, limits, exclusions",
      "limitations": "Any caps or restrictions"
    }
  ],
  "exclusions_or_limitations": [
    "Things explicitly NOT covered or rights you do NOT have"
  ],
  "termination_terms": {
    "how_to_cancel": "Process for cancellation",
    "notice_period": "Required notice period",
    "early_termination_penalty": "Any penalties",
    "auto_renewal": "Whether it auto-renews and how to opt out"
  },
  "risk_rating": {
    "score": "1-10 (1 = very favorable, 10 = very risky)",
    "assessment": "One paragraph plain-language overall assessment",
    "recommendation": "Key things the reader should watch out for or negotiate"
  },
  "plain_language_summary": "3-5 paragraph summary explaining the entire document in plain language that a non-lawyer can understand. Cover: what this document is, what you're agreeing to, what it costs, what the risks are, and what you should pay attention to."
}`

const QA_SYSTEM = `You are a document Q&A assistant. You have been given the full
text of a legal/business document. The user will ask questions about it.

CRITICAL RULES:
1. Answer ONLY based on what is in the document text provided
2. If the answer is not in the document, say "This is not addressed in the document"
3. Quote or reference specific sections/clauses when possible
4. Use plain language — explain legal terms if you reference them
5. Do NOT speculate about what the document "probably" means
6. Do NOT add information from your training data
7. If a question is ambiguous, explain what the document says about related topics

Keep answers focused and direct. Cite the relevant section when possible.`

const QA_PROMPT = (documentText, documentName, question) => `
Document: "${documentName}"

Full document text:
═══════════════════════════════════════════════════════════════
${documentText}
═══════════════════════════════════════════════════════════════

User's question: ${question}

Answer the question using ONLY the document contents above. If the document does not address this, say so clearly.`

// ── In-memory document session store ──────────────────────────────────────────
// Maps sessionId → { documentText, documentName, analysis, createdAt }
// Sessions expire after 2 hours to free memory

const sessions = new Map()
const SESSION_TTL_MS = 2 * 60 * 60 * 1000  // 2 hours
const MAX_SESSIONS   = 50

function pruneExpiredSessions() {
  const now = Date.now()
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      sessions.delete(id)
    }
  }
}

function storeSession(sessionId, data) {
  pruneExpiredSessions()
  if (sessions.size >= MAX_SESSIONS) {
    // Remove oldest session
    const oldest = sessions.keys().next().value
    sessions.delete(oldest)
  }
  sessions.set(sessionId, { ...data, createdAt: Date.now() })
}

export function getSession(sessionId) {
  const session = sessions.get(sessionId)
  if (!session) return null
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(sessionId)
    return null
  }
  return session
}

export function listSessions() {
  pruneExpiredSessions()
  return Array.from(sessions.entries()).map(([id, s]) => ({
    sessionId: id,
    documentName: s.documentName,
    createdAt: new Date(s.createdAt).toISOString(),
  }))
}

// ── Main analysis function ────────────────────────────────────────────────────

/**
 * Analyze a contract/legal document and return structured breakdown.
 *
 * @param {string} documentText - Full extracted text from the PDF
 * @param {object} opts         - { documentName, sessionId, pdfMetadata }
 * @returns {object}            - { sessionId, analysis, documentName, wordCount }
 */
export async function analyzeContract(documentText, opts = {}) {
  const {
    documentName = 'Uploaded Document',
    sessionId    = null,
    pdfMetadata  = {},
  } = opts

  if (!documentText || documentText.trim().length < 200) {
    throw new Error('Document text is too short — the PDF may be scanned or image-based')
  }

  // Truncate very long documents to stay within context limits
  const maxChars = 80000
  const truncated = documentText.length > maxChars
  const text = truncated
    ? documentText.slice(0, maxChars) + '\n\n[... document truncated at 80,000 characters]'
    : documentText

  const model = synthesisModel()

  const analysis = await model.completeJSON({
    system: ANALYSIS_SYSTEM,
    prompt: ANALYSIS_PROMPT(text, documentName),
  })

  // Store in session for follow-up Q&A
  const sid = sessionId || `doc-${Date.now().toString(36)}`
  storeSession(sid, {
    documentText: text,
    documentName,
    analysis,
    pdfMetadata,
  })

  return {
    sessionId: sid,
    documentName,
    analysis,
    wordCount: text.split(/\s+/).filter(Boolean).length,
    truncated,
    pageCount: pdfMetadata?.pages || null,
  }
}

// ── Q&A function ──────────────────────────────────────────────────────────────

/**
 * Answer a question using ONLY the stored document contents.
 *
 * @param {string} sessionId - Session from analyzeContract()
 * @param {string} question  - User's question about the document
 * @returns {object}         - { answer, documentName, sessionId }
 */
export async function askContractQuestion(sessionId, question) {
  const session = getSession(sessionId)
  if (!session) {
    throw new Error(
      'Document session not found or expired. ' +
      'Please upload the document again to start a new session.'
    )
  }

  if (!question || question.trim().length < 3) {
    throw new Error('Please provide a question about the document')
  }

  const model = synthesisModel()

  const answer = await model.complete({
    system: QA_SYSTEM,
    prompt: QA_PROMPT(session.documentText, session.documentName, question),
  })

  return {
    sessionId,
    documentName: session.documentName,
    question: question.trim(),
    answer: answer.trim(),
  }
}

// ── Format analysis as readable text ──────────────────────────────────────────

/**
 * Format the JSON analysis into a readable message for Telegram/WhatsApp.
 *
 * @param {object} result - Return value from analyzeContract()
 * @returns {string}      - Formatted text
 */
export function formatAnalysisForChat(result) {
  const a = result.analysis
  const lines = []

  lines.push(`📋 *Document Analysis: ${result.documentName}*`)
  lines.push(`Type: ${a.document_type || 'Unknown'}`)
  if (a.parties?.length) {
    lines.push(`Parties: ${a.parties.map(p => `${p.name} (${p.role})`).join(', ')}`)
  }
  if (a.effective_date) lines.push(`Effective: ${a.effective_date}`)
  if (a.expiration_date) lines.push(`Expires: ${a.expiration_date}`)
  lines.push('')

  // Risk rating
  if (a.risk_rating) {
    const emoji = a.risk_rating.score <= 3 ? '🟢' : a.risk_rating.score <= 6 ? '🟡' : '🔴'
    lines.push(`${emoji} *Risk Score: ${a.risk_rating.score}/10*`)
    lines.push(a.risk_rating.assessment)
    lines.push('')
  }

  // Plain language summary
  if (a.plain_language_summary) {
    lines.push(`📝 *Summary*`)
    lines.push(a.plain_language_summary)
    lines.push('')
  }

  // Risk flags
  if (a.risk_flags?.length) {
    lines.push(`⚠️ *Risk Flags (${a.risk_flags.length})*`)
    for (const flag of a.risk_flags) {
      const sev = flag.severity === 'high' ? '🔴' : flag.severity === 'medium' ? '🟡' : '🟢'
      lines.push(`${sev} ${flag.clause}: ${flag.risk}`)
    }
    lines.push('')
  }

  // Financial terms
  if (a.financial_terms?.length) {
    lines.push(`💰 *Financial Terms*`)
    for (const ft of a.financial_terms) {
      lines.push(`• ${ft.item}: ${ft.amount}${ft.frequency ? ` (${ft.frequency})` : ''}`)
    }
    lines.push('')
  }

  // Important dates
  if (a.important_dates?.length) {
    lines.push(`📅 *Important Dates*`)
    for (const d of a.important_dates) {
      lines.push(`• ${d.date}: ${d.significance}`)
    }
    lines.push('')
  }

  // Key obligations
  if (a.obligations?.length) {
    lines.push(`📌 *Your Obligations (${a.obligations.length})*`)
    for (const ob of a.obligations.slice(0, 8)) {
      lines.push(`• ${ob.obligation}${ob.deadline ? ` (by ${ob.deadline})` : ''}`)
    }
    if (a.obligations.length > 8) lines.push(`  ...and ${a.obligations.length - 8} more`)
    lines.push('')
  }

  // Termination
  if (a.termination_terms) {
    const t = a.termination_terms
    lines.push(`🚪 *Termination*`)
    if (t.how_to_cancel) lines.push(`• Cancel by: ${t.how_to_cancel}`)
    if (t.notice_period) lines.push(`• Notice: ${t.notice_period}`)
    if (t.auto_renewal) lines.push(`• Auto-renewal: ${t.auto_renewal}`)
    if (t.early_termination_penalty) lines.push(`• Early exit penalty: ${t.early_termination_penalty}`)
    lines.push('')
  }

  // Recommendation
  if (a.risk_rating?.recommendation) {
    lines.push(`💡 *Recommendation*`)
    lines.push(a.risk_rating.recommendation)
    lines.push('')
  }

  lines.push(`🔑 Session ID: \`${result.sessionId}\``)
  lines.push(`Ask follow-up questions with: "contract ask: ${result.sessionId} | your question here"`)

  return lines.join('\n')
}
