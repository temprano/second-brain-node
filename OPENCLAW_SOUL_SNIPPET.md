# Second Brain Skill — add this to your OpenClaw SOUL.md
# ─────────────────────────────────────────────────────────────────────────────
# Paste this block into your existing SOUL.md file under your skills or tools
# section. It tells the agent how to detect and route second brain commands.
# ─────────────────────────────────────────────────────────────────────────────

## Second Brain Pipeline

You have access to a second brain pipeline running on your VPS. When the user
sends a message matching the patterns below, call the second brain webhook
immediately without asking for confirmation.

### Trigger patterns

Trigger when the user message starts with any of these prefixes:
- `research:` — research a topic, find best options, compare alternatives
- `learning:` — deep dive into a subject for understanding and skill building
- `study:` — structured study material with definitions and key facts
- `review:` — summarise a book, product, tool, or service
- `news:` — gather latest developments on a topic

### What to do

When you detect one of these patterns:

1. POST to the second brain webhook immediately
2. Acknowledge to the user: "Queued! Researching '[topic]' now. I'll message
   you when it's done — usually 30-60 seconds."
3. When the completion webhook fires back, relay the summary to the user

### Webhook call

POST {{SECOND_BRAIN_WEBHOOK_URL}}/run
Headers:
  X-API-Key: {{SECOND_BRAIN_SECRET}}
  Content-Type: application/json
Body:
  { "command": "<full user message including the prefix>" }

### Response handling

The webhook responds immediately with:
  { "status": "queued", "jobId": "...", "intent": "...", "topic": "..." }

Acknowledge this to the user. The pipeline will POST back to your OpenClaw
/hooks/agent endpoint when complete with a full summary.

### Examples

User: "research: best home owners insurance right now"
→ POST /run { "command": "research: best home owners insurance right now" }
→ Reply: "Queued! Researching best home owners insurance. I'll message you
  when the note is in Obsidian and cards are in Anki — usually ~45 seconds."

User: "learning: Remotion full review"
→ POST /run { "command": "learning: Remotion full review" }
→ Reply: "On it! Deep-diving Remotion now. Note will land in
  100-Learning/Topics and cards in your Learning::Remotion Full Review deck."

User: "study: stoic philosophy core concepts"
→ POST /run { "command": "study: stoic philosophy core concepts" }
→ Reply: "Queued study session on stoic philosophy!"

### Error handling

If the webhook returns non-200, tell the user:
"Second brain pipeline is unreachable — check the VPS is running.
(pm2 logs second-brain)"

---

## PDF Upload

When the user sends a PDF file and wants it added to their second brain:

1. Receive the PDF attachment from the user
2. POST it to the VPS as a multipart/form-data upload:

```
POST {{SECOND_BRAIN_WEBHOOK_URL}}/upload
Headers:
  X-API-Key: {{SECOND_BRAIN_SECRET}}
Content-Type: multipart/form-data

Fields:
  file:       <the PDF binary>
  topic:      "home insurance"         (optional — inferred from filename if omitted)
  sourceName: "WSJ — Home Insurance"   (optional — human-readable label)
```

3. Acknowledge: "Got it! Extracting text from your PDF and processing...
   I'll message you when it's in Obsidian with flashcards — usually 30-60 seconds."

The pipeline will:
- Extract all text from the PDF
- Save the PDF to your Obsidian _attachments folder
- Find the existing note on that topic (or create a new one)
- Patch the note with insights and a link to the PDF
- Generate Anki cards from the source content
- Notify you when complete

### Example triggers to watch for:
- User sends a PDF attachment with no message → ask "What topic does this relate to?"
- User sends PDF + "add this to my home insurance research" → topic = "home insurance"
- User sends PDF + "process this" → infer topic from PDF filename

---

## Productivity Workflows

These three commands trigger the daily note, meeting processing, and weekly review:

### daily:
Trigger: user says "daily:", "create my daily note", "morning note", or similar

POST {{SECOND_BRAIN_WEBHOOK_URL}}/run
  { "command": "daily:" }

- Reads yesterday's note for open tasks
- Generates structured daily note with task sections + habit checkboxes
- Saves to _daily/YYYY-MM-DD.md in Obsidian
- Reply: "Done! Today's note is ready in Obsidian — [[_daily/YYYY-MM-DD]]"

### meeting: [raw notes]
Trigger: user says "meeting:" followed by raw notes, OR sends a voice
transcription about a meeting

POST {{SECOND_BRAIN_WEBHOOK_URL}}/run
  { "command": "meeting: [everything the user said about the meeting]" }

- Extracts action items with owners and due dates
- Formats as Obsidian Tasks syntax (- [ ] task 📅 date)
- Saves to _daily/meetings/YYYY-MM-DD-title.md
- These tasks appear automatically on the dashboard kanban
- Reply: "Meeting processed! X action items extracted → [[_daily/meetings/...]]"

### weekly:
Trigger: user says "weekly:", "weekly review", "how was my week", or
sends this on a Friday afternoon

POST {{SECOND_BRAIN_WEBHOOK_URL}}/run
  { "command": "weekly:" }

- Reads all daily notes from the last 7 days via Obsidian REST API
- Generates review with highlights, patterns, blockers, next week priorities
- Saves to _daily/reviews/weekly-YYYY-MM-DD.md
- Reply: "Weekly review done! [[_daily/reviews/weekly-...]]"
