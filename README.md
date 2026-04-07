# Second Brain Pipeline — Node.js

> Automated: topic → web research → Obsidian note → NotebookLM → Anki cards → AnkiDroid

## Architecture

```
You type a topic
      │
      ▼
┌─────────────────────────────────────────────────────────┐
│  Stage 1: Research Agent                                 │
│  Model: configurable (Anthropic / OpenAI / Gemini)      │
│  • Web search for current sources                        │
│  • Synthesise into key concepts + flashcards             │
│  • Optional: second model review pass (--review)         │
└───────────────────────┬─────────────────────────────────┘
                        │ structured JSON
                        ▼
┌─────────────────────────────────────────────────────────┐
│  Stage 2: Obsidian Connector                            │
│  • Builds formatted Markdown note with frontmatter      │
│  • Writes to vault via Local REST API plugin            │
│  • Falls back to local file if Obsidian not running     │
└───────────────────────┬─────────────────────────────────┘
                        │ note content + data
                        ▼
┌─────────────────────────────────────────────────────────┐
│  Stage 3: NotebookLM Connector (optional)               │
│  • Creates a new notebook for the topic                 │
│  • Uploads the Obsidian note as a source                │
│  • Generates: study guide, quiz, audio overview         │
│  • Extracts extra Anki cards from the quiz              │
└───────────────────────┬─────────────────────────────────┘
                        │ cards + quiz cards
                        ▼
┌─────────────────────────────────────────────────────────┐
│  Stage 4: Anki Connector                                │
│  • Auto-creates deck (Learning::Topic Name)             │
│  • Pushes Basic + Cloze cards via AnkiConnect           │
│  • Triggers AnkiWeb sync → appears in AnkiDroid         │
└─────────────────────────────────────────────────────────┘
```

## Provider-agnostic model routing

Each stage uses a different model — configure in `.env`:

```
MODEL_RESEARCH=anthropic:claude-sonnet-4-6   # web search + reasoning
MODEL_SYNTHESIS=anthropic:claude-sonnet-4-6  # structured output
MODEL_REVIEW=openai:gpt-4o-mini              # fast cheap review pass
```

Swap any line to use a different provider — no code changes:
```
MODEL_RESEARCH=google:gemini-2.0-flash       # faster, cheaper
MODEL_SYNTHESIS=openai:gpt-4o                # alternative synthesis
MODEL_REVIEW=anthropic:claude-haiku-4-5      # fast Anthropic option
```

## Setup

### 1. Install Node dependencies
```bash
npm install
```

### 2. Install Obsidian Local REST API plugin
- Obsidian → Settings → Community Plugins → Browse
- Search: **Local REST API** → Install → Enable
- Settings → copy your **API Key**

### 3. Configure .env
```bash
cp .env.example .env
# Edit .env with your keys
```

### 4. (Optional) Set up NotebookLM integration
```bash
pip install notebooklm-py
notebooklm auth login    # opens browser for Google sign-in
```
Then set `NOTEBOOKLM_ENABLED=true` in `.env`

### 5. Make sure Anki is running
- Anki must be open with AnkiConnect installed (addon: 2055492159)

## Usage

```bash
# Basic research
node src/pipeline/run.js "quantum computing"

# With NotebookLM audio overview (podcast)
node src/pipeline/run.js "stoic philosophy" --audio

# With card quality review pass
node src/pipeline/run.js "how TCP/IP works" --review

# Obsidian + NotebookLM only (no Anki)
node src/pipeline/run.js "Keynesian economics" --no-anki

# All features
node src/pipeline/run.js "CRISPR gene editing" --audio --review
```

## NotebookLM — current status (March 2026)

- **Consumer NotebookLM**: no official API. The pipeline uses `notebooklm-py`
  which reverse-engineers internal Google endpoints. Works well for personal
  use but may break if Google changes their internal APIs.

- **NotebookLM Enterprise**: official API available via Google Cloud project.
  If you have Enterprise access, replace the notebooklm.js connector with
  direct API calls to `discoveryengine.googleapis.com`.

- **Manual alternative**: the pipeline writes the Obsidian note with all
  content ready. You can manually drag the `.md` file into NotebookLM to
  generate an audio overview whenever you want.

## File structure

```
second-brain-pipeline/
├── src/
│   ├── providers/
│   │   └── llm.js           # Provider-agnostic LLM adapter
│   ├── agents/
│   │   └── research.js      # Research + card generation agent
│   ├── connectors/
│   │   ├── obsidian.js      # Obsidian Local REST API
│   │   ├── notebooklm.js    # NotebookLM via notebooklm-py CLI
│   │   └── anki.js          # AnkiConnect API
│   └── pipeline/
│       └── run.js           # Main orchestrator
├── .env.example
├── package.json
└── README.md
```
