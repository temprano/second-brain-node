/**
 * llm.js — Provider-agnostic LLM adapter
 *
 * Wraps any AI provider behind a single interface.
 * Swap models by changing .env — no code changes needed.
 *
 * Supported providers:
 *   anthropic  — Claude models (claude-sonnet-4-6, claude-opus-4-6, etc.)
 *   openai     — GPT models   (gpt-4o, gpt-4o-mini, etc.)
 *   google     — Gemini models (gemini-2.0-flash, gemini-2.5-pro, etc.)
 *   nvidia     — NVIDIA NIM hosted models via OpenAI-compatible API
 *                Includes Kimi K2.5 (multimodal) and Kimi K2 Instruct (agentic)
 *
 * Usage:
 *   const llm = new LLMProvider('nvidia:moonshotai/kimi-k2.5')
 *   const llm = new LLMProvider('nvidia:moonshotai/kimi-k2-instruct')
 *   const result = await llm.complete({ system, prompt })
 *   const json  = await llm.completeJSON({ system, prompt })
 *
 * NVIDIA NIM model strings:
 *   moonshotai/kimi-k2.5          — multimodal VLM (text + images + video)
 *   moonshotai/kimi-k2-instruct   — agentic text model, tool use, 128K ctx
 *   moonshotai/kimi-k2-thinking   — extended reasoning / chain-of-thought
 *   (see build.nvidia.com for full model catalogue)
 */

import Anthropic from '@anthropic-ai/sdk'

// ── Provider registry ─────────────────────────────────────────────────────────
// Each class implements: complete({ system, prompt, tools? }) → string

// ── Anthropic ─────────────────────────────────────────────────────────────────
class AnthropicProvider {
  constructor(model) {
    this.model = model
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  }

  async complete({ system, prompt, tools = [] }) {
    const params = {
      model: this.model,
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: prompt }],
    }

    if (tools.includes('web_search')) {
      params.tools = [{ type: 'web_search_20250305', name: 'web_search' }]
    }

    const response = await this.client.messages.create(params)
    const textBlocks = response.content.filter(b => b.type === 'text')
    return textBlocks.map(b => b.text).join('\n')
  }
}

// ── OpenAI ────────────────────────────────────────────────────────────────────
class OpenAIProvider {
  constructor(model, { baseURL = null, apiKey = null } = {}) {
    this.model  = model
    this.baseURL = baseURL
    this.apiKey  = apiKey
  }

  async complete({ system, prompt }) {
    const { default: OpenAI } = await import('openai')
    const client = new OpenAI({
      apiKey:  this.apiKey  || process.env.OPENAI_API_KEY,
      baseURL: this.baseURL || undefined,
    })
    const response = await client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: prompt },
      ],
      max_tokens: 4096,
    })
    return response.choices[0].message.content
  }
}

// ── Google Gemini ─────────────────────────────────────────────────────────────
class GeminiProvider {
  constructor(model) {
    this.model = model
  }

  async complete({ system, prompt }) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${process.env.GOOGLE_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: [{ parts: [{ text: prompt }] }],
        }),
      }
    )
    const data = await response.json()
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  }
}

// ── NVIDIA NIM ────────────────────────────────────────────────────────────────
// NVIDIA hosts many open models (Kimi K2.5, Kimi K2 Instruct, Llama, Mistral,
// etc.) behind an OpenAI-compatible API at integrate.api.nvidia.com/v1.
//
// Two Kimi models available:
//   moonshotai/kimi-k2.5         — multimodal (text + images + video), 1T params
//   moonshotai/kimi-k2-instruct  — agentic text model, tool use, 128K context
//   moonshotai/kimi-k2-thinking  — extended reasoning, chain-of-thought
//
// Kimi K2.5 thinking mode:
//   - Enabled by default. Returns reasoning_content + content fields.
//   - Temperature 1.0 recommended for thinking, 0.6 for instant mode.
//   - Disable thinking: add chat_template_kwargs: { thinking: false }
//
// Get a free NVIDIA API key at: build.nvidia.com (NVIDIA Developer Program)
// No payment required — free tier available.

const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1'

class NvidiaProvider {
  constructor(model, { thinkingMode = 'auto' } = {}) {
    this.model        = model
    this.thinkingMode = thinkingMode  // 'auto' | 'enabled' | 'disabled'
  }

  async complete({ system, prompt }) {
    const { default: OpenAI } = await import('openai')

    const client = new OpenAI({
      apiKey:  process.env.NVIDIA_API_KEY,
      baseURL: NVIDIA_BASE_URL,
    })

    // Kimi K2.5 thinking mode config
    // 'auto'     → let model decide (default — uses thinking for complex tasks)
    // 'enabled'  → always think (temperature 1.0, returns reasoning_content)
    // 'disabled' → instant mode (temperature 0.6, no reasoning trace)
    const isKimi    = this.model.includes('kimi')
    const isThinking = this.model.includes('thinking')

    const temperature = (() => {
      if (this.thinkingMode === 'disabled') return 0.6
      if (this.thinkingMode === 'enabled' || isThinking) return 1.0
      // auto: use 1.0 for kimi-k2.5 (thinking on by default), 0.6 for instruct
      return this.model.includes('k2.5') ? 1.0 : 0.6
    })()

    const extraParams = {}
    if (isKimi && this.thinkingMode === 'disabled') {
      extraParams.chat_template_kwargs = { thinking: false }
    }

    const response = await client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: prompt },
      ],
      max_tokens:  4096,
      temperature,
      ...extraParams,
    })

    const choice = response.choices[0].message

    // If thinking mode is on, reasoning_content contains the chain-of-thought.
    // We return only the final content (not the reasoning trace) to the pipeline.
    // To inspect reasoning: console.log(choice.reasoning_content)
    return choice.content ?? ''
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

function createProvider(modelString) {
  // Format: "provider:model-name"
  // NVIDIA models contain slashes: "nvidia:moonshotai/kimi-k2.5"
  const colonIdx = modelString.indexOf(':')
  const provider  = modelString.slice(0, colonIdx).toLowerCase()
  const model     = modelString.slice(colonIdx + 1)

  switch (provider) {
    case 'anthropic':
      return new AnthropicProvider(model)

    case 'openai':
      return new OpenAIProvider(model)

    case 'google':
    case 'gemini':
      return new GeminiProvider(model)

    case 'nvidia':
    case 'nim':
      return new NvidiaProvider(model)

    // Convenience aliases for common Kimi models
    case 'kimi':
      // "kimi:instruct"  → moonshotai/kimi-k2-instruct
      // "kimi:vision"    → moonshotai/kimi-k2.5
      // "kimi:thinking"  → moonshotai/kimi-k2-thinking
      // "kimi"           → moonshotai/kimi-k2-instruct (default)
      const kimiVariants = {
        'instruct': 'moonshotai/kimi-k2-instruct',
        'vision':   'moonshotai/kimi-k2.5',
        'thinking': 'moonshotai/kimi-k2-thinking',
        '':         'moonshotai/kimi-k2-instruct',
      }
      const kimiModel = kimiVariants[model] ?? `moonshotai/${model}`
      return new NvidiaProvider(kimiModel)

    default:
      throw new Error(
        `Unknown provider: "${provider}".\n` +
        `Supported: anthropic, openai, google, nvidia, kimi\n` +
        `Examples:\n` +
        `  anthropic:claude-sonnet-4-6\n` +
        `  openai:gpt-4o\n` +
        `  nvidia:moonshotai/kimi-k2-instruct\n` +
        `  nvidia:moonshotai/kimi-k2.5\n` +
        `  kimi:instruct\n` +
        `  kimi:vision`
      )
  }
}

// ── Main LLMProvider class ────────────────────────────────────────────────────

export class LLMProvider {
  constructor(modelString) {
    this.modelString = modelString
    this.provider    = createProvider(modelString)
  }

  /** Returns raw text */
  async complete({ system, prompt, tools = [] }) {
    return this.provider.complete({ system, prompt, tools })
  }

  /**
   * Returns parsed JSON. Automatically strips markdown fences.
   * Throws if the response is not valid JSON.
   */
  async completeJSON({ system, prompt, tools = [] }) {
    const raw = await this.complete({
      system: system + '\n\nIMPORTANT: Return ONLY a valid JSON object. No markdown, no explanation, no code fences.',
      prompt,
      tools,
    })

    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim()

    try {
      return JSON.parse(cleaned)
    } catch {
      const match = cleaned.match(/\{[\s\S]*\}/)
      if (match) return JSON.parse(match[0])
      throw new Error(`Model returned non-JSON response:\n${cleaned.slice(0, 300)}`)
    }
  }
}

// ── Model routing helpers ─────────────────────────────────────────────────────
// These read from .env so you can assign any provider to any pipeline role.

export function researchModel()  { return new LLMProvider(process.env.MODEL_RESEARCH  || 'anthropic:claude-sonnet-4-6') }
export function synthesisModel() { return new LLMProvider(process.env.MODEL_SYNTHESIS || 'anthropic:claude-sonnet-4-6') }
export function reviewModel()    { return new LLMProvider(process.env.MODEL_REVIEW    || 'openai:gpt-4o-mini') }
