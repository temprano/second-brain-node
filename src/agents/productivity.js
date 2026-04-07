/**
 * productivity.js — Productivity agent
 *
 * Handles the workflow-oriented intents inspired by Sonny Huynh's system:
 *   daily:    Generate today's daily note (pulls open tasks from yesterday)
 *   meeting:  Process raw meeting notes → extract tasks + action items
 *   weekly:   Generate weekly review from this week's daily notes
 *
 * Key difference from his Claude Code approach:
 *   - Triggered from OpenClaw on your phone, not the terminal
 *   - Reads vault notes via Obsidian Local REST API (not direct file access)
 *   - Works whether Obsidian is open or not (as long as REST API is running)
 *   - Writes results back to vault automatically
 */

import { researchModel } from '../providers/llm.js'
import { writeNote, searchVault, readNote } from '../connectors/obsidian.js'

// ── Daily note ────────────────────────────────────────────────────────────────

const DAILY_SYSTEM = `You are a personal productivity assistant.
You create structured daily notes for a knowledge worker.
Be concise, practical, and action-oriented.
Format output as clean Markdown with Obsidian-compatible task syntax.`

const DAILY_PROMPT = (date, dayName, openTasks, recentNotes) => `
Create today's daily note for ${dayName}, ${date}.

${openTasks.length > 0 ? `Open tasks carried over from yesterday or earlier:
${openTasks.map(t => `- ${t}`).join('\n')}` : 'No open tasks carried over.'}

${recentNotes.length > 0 ? `Recent notes context (for linking):
${recentNotes.slice(0, 5).map(n => `- [[${n}]]`).join('\n')}` : ''}

Return a JSON object:
{
  "title": "${date}",
  "content": "full markdown content for the daily note"
}

The daily note content should follow this structure exactly:
# ${date} — ${dayName}

## 🎯 Today's Focus
- 

## 📋 Open Tasks
[list any carried-over tasks as - [ ] items, or "- None carried over" if empty]

## 📅 Today's Tasks
- [ ] 

## 📝 Notes & Thoughts
[leave blank for the user to fill in]

## 🏃 Habits
- [ ] Exercise
- [ ] Read
- [ ] Meditate
- [ ] No alcohol
- [ ] 8 hours sleep
- [ ] Healthy eating

## 📊 Daily Review (fill in tonight)
**Energy level:** 
**What went well:** 
**What to improve:** 
**Tomorrow's priority:** 

Use Obsidian task syntax: - [ ] task text 📅 YYYY-MM-DD
Link to any relevant notes using [[note name]] syntax.
The habits list uses the exact names above — the dashboard tracks these automatically.`

export async function generateDailyNote(opts = {}) {
  const { existingTasks = [], recentNotes = [] } = opts

  const now     = new Date()
  const date    = now.toISOString().split('T')[0]
  const dayName = now.toLocaleDateString('en-US', { weekday: 'long' })

  const model  = researchModel()
  const result = await model.completeJSON({
    system: DAILY_SYSTEM,
    prompt: DAILY_PROMPT(date, dayName, existingTasks, recentNotes),
  })

  const filename = `_daily/${date}.md`
  await writeNote(filename, result.content)

  return { filename, date, dayName, tasksCarried: existingTasks.length }
}

// ── Meeting note processor ────────────────────────────────────────────────────

const MEETING_SYSTEM = `You are a meeting notes processor and project management assistant.
Extract structured information from raw meeting notes.
Format action items as Obsidian Tasks plugin syntax with due dates.
Be specific — generic action items are useless.`

const MEETING_PROMPT = (rawNotes, date) => `
Process these raw meeting notes from ${date}:

---
${rawNotes}
---

Return a JSON object:
{
  "title": "Meeting title (infer from context)",
  "attendees": ["name1", "name2"],
  "summary": "2-3 sentence summary of what was discussed and decided",
  "decisions": ["Decision made 1", "Decision made 2"],
  "action_items": [
    {
      "task": "Specific action item description",
      "owner": "Person responsible (or 'Me' if unclear)",
      "due": "YYYY-MM-DD or null if not mentioned",
      "project": "project tag"
    }
  ],
  "follow_ups": ["Thing to follow up on"],
  "content": "full formatted markdown note"
}

The content field should be:
# Meeting: [title]
**Date:** ${date}
**Attendees:** [names]

## Summary
[2-3 sentences]

## Decisions
- [decisions]

## Action Items
- [ ] [task] (Owner: [owner]) 📅 [due date if known]

## Notes
[key discussion points]

## Follow-ups
- [follow-ups]

For action items without explicit due dates, infer reasonable ones from context.
Use Obsidian task format: - [ ] task text 📅 YYYY-MM-DD`

export async function processMeetingNote(rawNotes, opts = {}) {
  const { sourceName = 'Meeting' } = opts
  const date = new Date().toISOString().split('T')[0]

  const model  = researchModel()
  const result = await model.completeJSON({
    system: MEETING_SYSTEM,
    prompt: MEETING_PROMPT(rawNotes, date),
  })

  // Safe filename from meeting title
  const safe     = (result.title || 'Meeting')
    .replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-')
  const filename = `_daily/meetings/${date}-${safe}.md`

  await writeNote(filename, result.content)

  return {
    filename,
    title:       result.title,
    actionItems: (result.action_items || []).length,
    decisions:   (result.decisions    || []).length,
    attendees:   (result.attendees    || []),
    summary:     result.summary,
  }
}

// ── Weekly review ─────────────────────────────────────────────────────────────

const WEEKLY_SYSTEM = `You are a thoughtful personal productivity coach.
You generate honest, insightful weekly reviews from a person's daily notes.
Surface patterns, celebrate wins, and identify genuine blockers.
Be specific — reference actual things mentioned in the notes.`

const WEEKLY_PROMPT = (weekNotes, startDate, endDate) => `
Generate a weekly review for the week of ${startDate} to ${endDate}.

Here are the daily notes from this week:
---
${weekNotes}
---

Return a JSON object:
{
  "title": "Weekly Review — ${startDate}",
  "highlights": ["Top accomplishment 1", "Top accomplishment 2", "Top accomplishment 3"],
  "completed_count": number,
  "patterns_noticed": ["Pattern or insight from the week"],
  "blockers": ["What slowed things down"],
  "next_week_priorities": ["Priority 1", "Priority 2", "Priority 3"],
  "content": "full markdown weekly review"
}

The content field should follow this structure:
# Weekly Review — ${startDate} to ${endDate}

## 🏆 Highlights
[top 3 wins or accomplishments]

## 📊 Stats
**Tasks completed:** [count]
**Days with notes:** [count]

## 🔍 Patterns & Insights
[what you noticed about how the week went]

## 🚧 Blockers & Friction
[what slowed things down]

## 📋 Next Week's Priorities
1. [priority 1]
2. [priority 2]  
3. [priority 3]

## 💭 Reflection
[1-2 honest sentences about the week overall]

Be specific — reference actual projects, tasks, and topics from the notes.`

export async function generateWeeklyReview(opts = {}) {
  const { weekNotes = '' } = opts

  const now       = new Date()
  const dayOfWeek = now.getDay()
  const monday    = new Date(now)
  monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1))
  const startDate = monday.toISOString().split('T')[0]
  const endDate   = now.toISOString().split('T')[0]

  if (!weekNotes || weekNotes.trim().length < 50) {
    throw new Error(
      'No daily notes content found for this week. ' +
      'Make sure daily notes exist in _daily/ and Obsidian is running.'
    )
  }

  const model  = researchModel()
  const result = await model.completeJSON({
    system: WEEKLY_SYSTEM,
    prompt: WEEKLY_PROMPT(weekNotes, startDate, endDate),
  })

  const filename = `_daily/reviews/weekly-${startDate}.md`
  await writeNote(filename, result.content)

  return {
    filename,
    startDate,
    endDate,
    highlights:  result.highlights || [],
    priorities:  result.next_week_priorities || [],
    completed:   result.completed_count || 0,
  }
}

// ── Vault reader — fetches this week's daily notes via REST API ───────────────

export async function fetchThisWeekNotes() {
  const notes = []
  const now   = new Date()

  // Get last 7 days
  for (let i = 0; i < 7; i++) {
    const d    = new Date(now)
    d.setDate(now.getDate() - i)
    const date = d.toISOString().split('T')[0]

    try {
      const content = await readNote(`_daily/${date}.md`)
      if (content && content.trim().length > 50) {
        notes.push(`\n## ${date}\n${content}`)
      }
    } catch {
      // Note doesn't exist for that day — skip
    }
  }

  return notes.join('\n\n---\n\n')
}

export async function fetchYesterdayOpenTasks() {
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  const date = yesterday.toISOString().split('T')[0]

  try {
    const content = await readNote(`_daily/${date}.md`)
    if (!content) return []

    // Extract unchecked tasks: lines matching - [ ] pattern
    return content
      .split('\n')
      .filter(line => /^- \[ \]/.test(line.trim()))
      .map(line => line.trim().replace(/^- \[ \] /, ''))
      .filter(Boolean)
  } catch {
    return []
  }
}
