/**
 * Token Rate Extension (sliding-window, event-loop-safe)
 *
 * Shows live tok/s in the footer.  Uses a 3-second sliding window
 * and pushes status updates onto setImmediate so the extension event
 * handler returns instantly and never blocks the next streaming event.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Sample { timeMs: number; chars: number; }

interface RateState {
  samples: Sample[];
  totalChars: number;
  finalTokens: number | null;
  fadeTimer: NodeJS.Timeout | null;
  // Pause detection: freeze rate during tool-call / thinking pauses
  paused: boolean;
  frozenRate: number | null;
  pauseTimer: NodeJS.Timeout | null;
  lastActivityMs: number;
  // Digest time: model digest latency (message_start → first token)
  digestStartMs: number | null;
  digestTimes: number[];      // rolling history in ms
}

const state: RateState = {
  samples: [],
  totalChars: 0,
  finalTokens: null,
  fadeTimer: null,
  // Pause detection
  paused: false,
  frozenRate: null,
  pauseTimer: null,
  lastActivityMs: Date.now(),
  // Digest time
  digestStartMs: null,
  digestTimes: [],
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WINDOW_MS    = 3000;   // sliding-window size
const UPDATE_MS    = 2000;   // throttle status updates to 2 s
const MIN_SAMPLES  = 2;
const CHARS_PER_TOK = 4;
const PAUSE_THRESHOLD_MS = 2000; // consider it a pause if no tokens for this long

// ANSI fallback
const GREEN  = "\x1b[32m";  const CYAN   = "\x1b[36m";
const YELLOW = "\x1b[33m";  const RED    = "\x1b[31m";
const RESET  = "\x1b[39m";
const GREY   = "\x1b[90m";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeRate(s: RateState): number | null {
  // If we're in a pause, return the frozen rate so we don't decay to 0
  if (s.paused && s.frozenRate !== null) return s.frozenRate;

  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const win = s.samples.filter((x) => x.timeMs >= cutoff);
  if (win.length < MIN_SAMPLES) return null;

  const windowedChars = win.reduce((sum, x) => sum + x.chars, 0);
  if (windowedChars <= 0) return null;

  let tokens = Math.round(windowedChars / CHARS_PER_TOK);

  // Re-scale to accurate count once available
  if (s.finalTokens !== null) {
    const totalEstimated = Math.round(s.totalChars / CHARS_PER_TOK);
    if (totalEstimated > 0) {
      tokens = Math.round((tokens / totalEstimated) * s.finalTokens);
    }
  }

  const t0 = win[0]!.timeMs;
  const t1 = win[win.length - 1]!.timeMs;
  const durSec = (t1 - t0) / 1000;
  if (durSec <= 0) return null;
  return tokens / durSec;
}

function freezePause(s: RateState) {
  if (s.paused) return; // already frozen
  const rate = computeRateInternal(s);
  if (rate !== null) {
    s.paused = true;
    s.frozenRate = rate;
  }
}

// Internal: compute without pause-freeze shortcut (to avoid double-freezing)
function computeRateInternal(s: RateState): number | null {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const win = s.samples.filter((x) => x.timeMs >= cutoff);
  if (win.length < MIN_SAMPLES) return null;

  const windowedChars = win.reduce((sum, x) => sum + x.chars, 0);
  if (windowedChars <= 0) return null;

  let tokens = Math.round(windowedChars / CHARS_PER_TOK);

  if (s.finalTokens !== null) {
    const totalEstimated = Math.round(s.totalChars / CHARS_PER_TOK);
    if (totalEstimated > 0) {
      tokens = Math.round((tokens / totalEstimated) * s.finalTokens);
    }
  }

  const t0 = win[0]!.timeMs;
  const t1 = win[win.length - 1]!.timeMs;
  const durSec = (t1 - t0) / 1000;
  if (durSec <= 0) return null;
  return tokens / durSec;
}

function fmt(rate: number): string {
  const n = Math.round(rate);
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k tok/s`;
  return `${n} tok/s`;
}

function fmtDigest(sec: number): string {
  if (sec >= 10) return `${sec.toFixed(1)}s`;
  return `${sec.toFixed(2)}s`;
}

function meanDigestSec(s: RateState): number | null {
  if (s.digestTimes.length === 0) return null;
  const sum = s.digestTimes.reduce((a, b) => a + b, 0);
  return sum / s.digestTimes.length / 1000;
}

function colorName(rate: number): "success" | "accent" | "warning" | "error" {
  if (rate >= 100) return "success";
  if (rate >= 30)  return "accent";
  if (rate >= 5)   return "warning";
  return "error";
}

function ansiColor(rate: number): string {
  if (rate >= 100) return GREEN;
  if (rate >= 30)  return CYAN;
  if (rate >= 5)   return YELLOW;
  return RED;
}

let lastUpdateMs = 0;
let capturedCtx: ExtensionContext | null = null;

function scheduleSetStatus(force = false) {
  if (!capturedCtx) return;

  const now = Date.now();
  if (!force && now - lastUpdateMs < UPDATE_MS) return;
  lastUpdateMs = now;

  setImmediate(() => {
    const rawRate = computeRate(state);
    const hasLive = rawRate !== null && !state.paused;
    const hasFrozen = state.frozenRate !== null;

    // Hide only if we have absolutely no data
    if (!hasLive && !hasFrozen) {
      capturedCtx!.ui.setStatus("token-rate", "");
      return;
    }

    const displayRate = hasLive ? rawRate : state.frozenRate!;
    const rateLabel = ` ⚡ ${fmt(displayRate)}`;
    const theme = capturedCtx!.ui.theme;

    // Build digest suffix if we have data
    const digestSec = meanDigestSec(state);
    let fullLabel: string;
    if (digestSec !== null) {
      fullLabel = `${rateLabel}  ·  ⏱ ${fmtDigest(digestSec)}`;
    } else {
      fullLabel = rateLabel;
    }

    if (hasLive) {
      const color = colorName(displayRate);
      if (theme && typeof theme.fg === "function") {
        capturedCtx!.ui.setStatus("token-rate", theme.fg(color, fullLabel));
      } else {
        capturedCtx!.ui.setStatus("token-rate", `${ansiColor(displayRate)}${fullLabel}${RESET}`);
      }
    } else {
      // Frozen: show grey
      if (theme && typeof theme.fg === "function") {
        capturedCtx!.ui.setStatus("token-rate", theme.fg("muted", fullLabel));
      } else {
        capturedCtx!.ui.setStatus("token-rate", `${GREY}${fullLabel}${RESET}`);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {

  pi.on("message_start", async (event, ctx) => {
    if (event.message.role === "assistant") {
      // Cancel any pending timers
      if (state.fadeTimer) {
        clearTimeout(state.fadeTimer);
        state.fadeTimer = null;
      }
      if (state.pauseTimer) {
        clearTimeout(state.pauseTimer);
        state.pauseTimer = null;
      }
      // Reset streaming state but KEEP frozenRate as a fallback
      state.samples = [];
      state.totalChars = 0;
      state.finalTokens = null;
      state.paused = false;
      lastUpdateMs = 0;
      capturedCtx = ctx;
      // Record digest start — the clock starts now
      state.digestStartMs = Date.now();
      // Show the frozen rate so the display never disappears
      scheduleSetStatus(true);
    }
  });

  pi.on("message_update", async (event, ctx) => {
    const em = event.assistantMessageEvent;
    if (
      em.type === "text_delta" ||
      em.type === "thinking_delta" ||
      em.type === "toolcall_delta"
    ) {
      const now = Date.now();

      // First token — measure digest time
      if (state.digestStartMs !== null) {
        const digestMs = now - state.digestStartMs;
        state.digestTimes.push(digestMs);
        // Keep last 20 digest samples
        if (state.digestTimes.length > 20) {
          state.digestTimes = state.digestTimes.slice(-20);
        }
        state.digestStartMs = null;
      }

      // New tokens arrived — clear pause and switch to live mode
      state.paused = false;
      state.lastActivityMs = now;
      state.totalChars += em.delta.length;
      state.samples.push({ timeMs: now, chars: em.delta.length });

      // Once we have enough samples for a live rate, discard frozen fallback
      if (state.samples.length >= MIN_SAMPLES) {
        state.frozenRate = null;
      }

      // Prune old samples
      const cutoff = now - WINDOW_MS - 5000;
      if (state.samples.length > 50) {
        state.samples = state.samples.filter((s) => s.timeMs >= cutoff);
      }

      // Schedule a pause freeze if we haven't seen tokens in PAUSE_THRESHOLD_MS
      if (state.pauseTimer) clearTimeout(state.pauseTimer);
      state.pauseTimer = setTimeout(() => freezePause(state), PAUSE_THRESHOLD_MS);

      scheduleSetStatus();
    }
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role === "assistant") {
      const msg = event.message as AssistantMessage;
      state.finalTokens = msg.usage.output;

      // Cancel pause timer since streaming has ended
      if (state.pauseTimer) {
        clearTimeout(state.pauseTimer);
        state.pauseTimer = null;
      }

      // Freeze with final rate for display persistence
      state.frozenRate = computeRateInternal(state) ?? state.frozenRate;
      state.paused = false;
      scheduleSetStatus(true);
    }
  });
}
