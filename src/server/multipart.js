/**
 * multipart.js — Simple multipart/form-data parser
 *
 * Parses incoming HTTP requests containing file uploads.
 * No external dependencies — pure Node.js.
 *
 * Handles:
 *   - multipart/form-data with file fields
 *   - Mixed text fields + file fields in one request
 *   - PDF, text, and other binary file types
 *
 * Returns:
 *   { fields: { key: value }, files: { fieldname: { buffer, filename, mimetype } } }
 */

/**
 * Parse a multipart/form-data request.
 *
 * @param {IncomingMessage} req - Node.js HTTP request object
 * @returns {Promise<{ fields, files }>}
 */
export async function parseMultipart(req) {
  const contentType = req.headers['content-type'] || ''

  // Extract boundary from Content-Type header
  const boundaryMatch = contentType.match(/boundary=([^\s;]+)/)
  if (!boundaryMatch) {
    throw new Error('No boundary found in Content-Type header')
  }

  const boundary = '--' + boundaryMatch[1]

  // Read entire body as buffer
  const body = await new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })

  const fields = {}
  const files  = {}

  // Split on boundary
  const parts = splitBuffer(body, Buffer.from('\r\n' + boundary))
  // Skip preamble and closing part
  const validParts = parts.slice(1).filter(p => !p.toString().startsWith('--\r\n') && p.length > 0)

  for (const part of validParts) {
    // Split headers from body (separated by \r\n\r\n)
    const headerEnd = findSequence(part, Buffer.from('\r\n\r\n'))
    if (headerEnd === -1) continue

    const headerSection = part.slice(0, headerEnd).toString()
    const partBody      = part.slice(headerEnd + 4)  // skip \r\n\r\n

    // Remove trailing \r\n if present
    const content = partBody[partBody.length - 2] === 13 && partBody[partBody.length - 1] === 10
      ? partBody.slice(0, -2)
      : partBody

    // Parse headers
    const headers = {}
    for (const line of headerSection.split('\r\n')) {
      const idx = line.indexOf(':')
      if (idx > 0) {
        headers[line.slice(0, idx).toLowerCase().trim()] = line.slice(idx + 1).trim()
      }
    }

    // Parse Content-Disposition
    const disposition = headers['content-disposition'] || ''
    const nameMatch   = disposition.match(/name="([^"]+)"/)
    const fnameMatch  = disposition.match(/filename="([^"]+)"/)

    if (!nameMatch) continue
    const fieldName = nameMatch[1]

    if (fnameMatch) {
      // File field
      files[fieldName] = {
        buffer:   content,
        filename: fnameMatch[1],
        mimetype: headers['content-type'] || 'application/octet-stream',
        size:     content.length,
      }
    } else {
      // Text field
      fields[fieldName] = content.toString('utf8')
    }
  }

  return { fields, files }
}

// ── Buffer helpers ────────────────────────────────────────────────────────────

function splitBuffer(buf, delimiter) {
  const parts  = []
  let   start  = 0

  while (start < buf.length) {
    const idx = findSequence(buf, delimiter, start)
    if (idx === -1) {
      parts.push(buf.slice(start))
      break
    }
    parts.push(buf.slice(start, idx))
    start = idx + delimiter.length
  }

  return parts
}

function findSequence(buf, seq, offset = 0) {
  outer: for (let i = offset; i <= buf.length - seq.length; i++) {
    for (let j = 0; j < seq.length; j++) {
      if (buf[i + j] !== seq[j]) continue outer
    }
    return i
  }
  return -1
}
