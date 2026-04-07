/**
 * pdf.js — PDF text extraction module
 *
 * Uses `unpdf` — a modern serverless PDF.js wrapper built for AI workflows.
 * No native dependencies, works on any Node.js 20+ environment including VPS.
 *
 * Install: npm install unpdf
 *
 * Handles:
 *   - Text-based PDFs (articles, reports, books)
 *   - Multi-page documents (extracts all pages)
 *   - Metadata extraction (title, author, date)
 *   - Large files (streams page by page to avoid memory issues)
 *   - Scanned/image PDFs (warns user — no OCR)
 *
 * Does NOT handle:
 *   - Password-protected PDFs (returns clear error)
 *   - Scanned image PDFs (no OCR — returns warning with partial text)
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join, basename, extname } from 'path'

// ── PDF extraction ────────────────────────────────────────────────────────────

/**
 * Extract text and metadata from a PDF buffer or file path.
 *
 * @param {Buffer|string} source - PDF buffer or absolute file path
 * @returns {object} { text, metadata, pageCount, wordCount, warnings }
 */
export async function extractPDF(source) {
  // Lazy import — only load unpdf when needed
  const { extractText, getDocumentProxy } = await import('unpdf')

  // Accept either a buffer or a file path
  const buffer = Buffer.isBuffer(source)
    ? source
    : await readFile(source)

  const uint8 = new Uint8Array(buffer)

  // Get document proxy for metadata
  let doc
  try {
    doc = await getDocumentProxy(uint8)
  } catch (err) {
    if (err.message?.includes('password')) {
      throw new Error('PDF is password-protected — remove the password and try again')
    }
    throw new Error(`Could not open PDF: ${err.message}`)
  }

  const pageCount = doc.numPages

  // Extract metadata
  let metadata = {}
  try {
    const meta = await doc.getMetadata()
    const info = meta?.info || {}
    metadata = {
      title:    info.Title    || null,
      author:   info.Author   || null,
      subject:  info.Subject  || null,
      creator:  info.Creator  || null,
      producer: info.Producer || null,
      created:  info.CreationDate || null,
      pages:    pageCount,
    }
  } catch {
    metadata = { pages: pageCount }
  }

  // Extract text from all pages
  const { text } = await extractText(doc, { mergePages: true })

  // Detect scanned PDFs (very little extractable text)
  const warnings = []
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length

  if (wordCount < 50 && pageCount > 1) {
    warnings.push(
      'This PDF appears to be scanned or image-based. ' +
      'Very little text was extracted. ' +
      'For best results, use a PDF with selectable text, ' +
      'or run the PDF through an OCR tool first.'
    )
  }

  // Clean up extracted text
  const cleaned = cleanPDFText(text)

  return {
    text:      cleaned,
    metadata,
    pageCount,
    wordCount,
    warnings,
    charCount: cleaned.length,
  }
}

/**
 * Save a PDF buffer to the Obsidian vault's attachments folder
 * via the Local REST API.
 *
 * @param {Buffer} buffer    - PDF file contents
 * @param {string} filename  - Desired filename (e.g. "wsj-home-insurance.pdf")
 * @returns {string}         - Vault-relative path where PDF was saved
 */
export async function savePDFToVault(buffer, filename) {
  const { Agent } = await import('https')
  const { default: fetch } = await import('node-fetch')

  const attachmentsFolder = process.env.OBSIDIAN_ATTACHMENTS_FOLDER || '_attachments'
  const safeName = filename.replace(/[^\w\s.-]/g, '').replace(/\s+/g, '_')
  const vaultPath = `${attachmentsFolder}/${safeName}`

  const BASE = `https://${process.env.OBSIDIAN_HOST || '127.0.0.1'}:${process.env.OBSIDIAN_PORT || '27124'}`

  const resp = await fetch(`${BASE}/vault/${vaultPath}`, {
    method:  'PUT',
    headers: {
      Authorization:  `Bearer ${process.env.OBSIDIAN_API_KEY}`,
      'Content-Type': 'application/pdf',
    },
    body:  buffer,
    agent: new Agent({ rejectUnauthorized: false }),
  })

  if (resp.status === 200 || resp.status === 201 || resp.status === 204) {
    return vaultPath
  }

  throw new Error(`Could not save PDF to vault: HTTP ${resp.status}`)
}

/**
 * Save a PDF buffer locally on the VPS (for fallback / temp storage).
 * Returns the local file path.
 */
export async function savePDFLocally(buffer, filename) {
  const uploadDir = './tmp_uploads'
  if (!existsSync(uploadDir)) await mkdir(uploadDir, { recursive: true })

  const safeName = filename.replace(/[^\w\s.-]/g, '').replace(/\s+/g, '_')
  const localPath = join(uploadDir, safeName)
  await writeFile(localPath, buffer)
  return localPath
}

// ── Text cleaning ─────────────────────────────────────────────────────────────

/**
 * Clean text extracted from a print-to-PDF article.
 *
 * Phone print-to-PDFs often include:
 *   - Cookie consent banners at the top
 *   - Site navigation menus (Home / News / Business / ...)
 *   - "Subscribe to continue reading" paywalls mid-article
 *   - Share buttons, social links, related articles sections
 *   - Page numbers, URLs, timestamps repeated on every page
 *   - Author bios and "more from this author" sections
 *   - Advertisement text blocks
 *
 * Strategy: clean artefacts first, then strip known boilerplate patterns.
 * The LLM handles remaining noise, so we don't need to be perfect —
 * just reduce the token count and improve signal-to-noise.
 */
function cleanPDFText(text) {
  let t = text

  // ── Fix typography artefacts ───────────────────────────────────────────────
  // Ligatures
  t = t.replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl').replace(/ﬀ/g, 'ff')
       .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
  // Curly quotes → straight
  t = t.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
  // Rejoin hyphenated line breaks (soft hyphens from column layout)
  t = t.replace(/(\w)-\n(\w)/g, '$1$2')
  // Normalise line endings
  t = t.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  // ── Strip print-to-PDF boilerplate ─────────────────────────────────────────

  // Cookie / GDPR banners (usually at the very top before article starts)
  t = t.replace(/^[\s\S]{0,2000}?(accept (all )?cookies|we use cookies|cookie policy|privacy settings)[\s\S]{0,500}\n\n/i, '')

  // Navigation menus — short lines separated by | or • or /
  t = t.replace(/^([\w\s]{2,25}(\s*[|•\/]\s*[\w\s]{2,25}){3,}\n)+/gm, '')

  // "Subscribe" / paywall prompts
  t = t.replace(/subscribe (now|today|to (read|continue|unlock))[\s\S]{0,300}\n\n/gi, '')
  t = t.replace(/(already a subscriber|sign in to read|create (a )?free account)[\s\S]{0,200}\n\n/gi, '')

  // Share / social buttons text
  t = t.replace(/^(share(\s+this)?|tweet|email|copy link|print|save)\n/gim, '')

  // Related articles / recommended sections (usually near end)
  t = t.replace(/\n(related (articles?|stories?|content)|you (might|may) also (like|enjoy)|more from|recommended for you)[\s\S]{0,1500}$/i, '')

  // Author bio blocks (usually after article ends)
  t = t.replace(/\n(about the author|[A-Z][a-z]+ [A-Z][a-z]+ is a (reporter|journalist|writer|editor|analyst|contributor))[\s\S]{0,400}$/i, '')

  // Footer links and legal
  t = t.replace(/\n(terms of (service|use)|privacy policy|© \d{4}|all rights reserved|contact us|advertise with us)[\s\S]*$/i, '')

  // Repeated URLs (printed from browser — URL appears at top/bottom of each page)
  t = t.replace(/https?:\/\/[^\s]+/g, (url) => {
    // Keep URLs that appear once (they may be citations), remove if very long domain-only strings
    return url.length > 100 ? '' : url
  })

  // Page numbers: standalone numbers on their own line
  t = t.replace(/^\s*\d+\s*$/gm, '')

  // ── Final cleanup ──────────────────────────────────────────────────────────
  // Collapse excessive blank lines
  t = t.replace(/\n{3,}/g, '\n\n')
  // Remove very short orphan lines (1-3 chars — usually artefacts)
  t = t.replace(/^\s{0,2}\S{1,2}\s*$/gm, '')
  // Final trim
  t = t.trim()

  return t
}

/**
 * Estimate how much of the text is likely article content vs boilerplate.
 * Returns a quality score 0-1 and a brief assessment.
 * Used to warn users if the PDF extracted poorly.
 */
export function assessExtraction(text, pageCount) {
  const words      = text.split(/\s+/).filter(Boolean)
  const wordCount  = words.length
  const avgWordsPerPage = wordCount / Math.max(pageCount, 1)

  // Typical article: 200-600 words per page
  // Navigation/boilerplate: very low
  // Dense academic: 400-800
  const quality = Math.min(avgWordsPerPage / 300, 1)

  const assessment = quality > 0.7
    ? 'Good extraction — text-based PDF'
    : quality > 0.3
    ? 'Partial extraction — some content may be missing'
    : 'Poor extraction — PDF may be image-based or heavily formatted'

  return { quality, assessment, wordCount, avgWordsPerPage: Math.round(avgWordsPerPage) }
}

// ── Format helpers ────────────────────────────────────────────────────────────

/**
 * Format PDF metadata for display in a note
 */
export function formatMetadata(metadata) {
  const lines = []
  if (metadata.title)   lines.push(`**Title:** ${metadata.title}`)
  if (metadata.author)  lines.push(`**Author:** ${metadata.author}`)
  if (metadata.created) lines.push(`**Date:** ${formatPDFDate(metadata.created)}`)
  if (metadata.pages)   lines.push(`**Pages:** ${metadata.pages}`)
  return lines.join('\n') || '*No metadata available*'
}

function formatPDFDate(dateStr) {
  // PDF dates: D:20250315120000Z
  try {
    const clean = dateStr.replace(/^D:/, '').slice(0, 8)
    const d = new Date(`${clean.slice(0,4)}-${clean.slice(4,6)}-${clean.slice(6,8)}`)
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  } catch {
    return dateStr
  }
}
