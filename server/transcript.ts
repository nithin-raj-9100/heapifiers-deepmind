/**
 * Transcript hypothesis merging for Gemini Live transcription streams.
 *
 * Ported from the Swift foundation in `gemini-whisper-local-main`
 * (GeminiLive.swift / DictationSession.swift). Gemini Live streams revised interim
 * hypotheses and occasionally starts a fresh window mid-utterance. These helpers keep
 * already-completed windows apart from the hypothesis still being revised, so words are
 * neither duplicated (a revised tail appended twice) nor dropped (a new window replacing
 * earlier speech).
 */

export function normalizeTranscript(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

interface Token {
  raw: string;
  norm: string;
}

/** Whitespace tokens paired with a letters/digits-only lowercase form for comparison. */
function tokenize(text: string): Token[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((raw) => ({ raw, norm: raw.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "") }))
    .filter((token) => token.norm.length > 0);
}

function sameWords(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((word, index) => word === b[index]);
}

function rawJoin(tokens: Token[]): string {
  return tokens.map((token) => token.raw).join(" ");
}

/**
 * Append `right` to `left` without repeating an overlap: exact containment is
 * collapsed, and a suffix of `left` that equals a prefix of `right` (two or more
 * words) is emitted once.
 */
export function joinUniqueTranscript(left: string, right: string): string {
  const lhs = left.trim();
  const rhs = right.trim();
  if (!lhs) return rhs;
  if (!rhs) return lhs;

  const normalizedLeft = normalizeTranscript(lhs);
  const normalizedRight = normalizeTranscript(rhs);
  if (normalizedLeft.includes(normalizedRight)) return lhs;
  if (normalizedRight.includes(normalizedLeft)) return rhs;

  const leftWords = tokenize(lhs).map((token) => token.norm);
  const rightTokens = tokenize(rhs);
  const rightWords = rightTokens.map((token) => token.norm);
  const maximumOverlap = Math.min(leftWords.length, rightWords.length);
  for (let count = maximumOverlap; count >= 2; count--) {
    if (sameWords(leftWords.slice(leftWords.length - count), rightWords.slice(0, count))) {
      return `${lhs} ${rawJoin(rightTokens.slice(count))}`;
    }
  }
  return `${lhs} ${rhs}`;
}

/**
 * Returns the single revised hypothesis when `update` is an edit, extension or
 * sliding continuation of `previous`, or null when it begins a genuinely new window.
 */
function reconcileHypothesis(previous: string, update: string): string | null {
  const oldTokens = tokenize(previous);
  const newTokens = tokenize(update);
  if (oldTokens.length === 0 || newTokens.length === 0) return update;
  const oldWords = oldTokens.map((token) => token.norm);
  const newWords = newTokens.map((token) => token.norm);
  if (sameWords(oldWords, newWords)) return update;

  let commonPrefix = 0;
  while (commonPrefix < oldWords.length && commonPrefix < newWords.length && oldWords[commonPrefix] === newWords[commonPrefix]) {
    commonPrefix++;
  }
  if (newWords.length >= oldWords.length) {
    if (commonPrefix >= 2 || commonPrefix * 2 >= oldWords.length) return update;
  } else if (Math.abs(oldWords.length - newWords.length) <= 3 && commonPrefix >= 2) {
    return update;
  }

  // A sliding update can restart from words already inside the active hypothesis:
  // keep the untouched prefix and replace only its tail.
  if (newWords.length >= 2) {
    for (let index = 0; index + 1 < oldWords.length; index++) {
      if (oldWords[index] === newWords[0] && oldWords[index + 1] === newWords[1]) {
        return joinUniqueTranscript(rawJoin(oldTokens.slice(0, index)), update);
      }
    }
  }

  // Or it can continue from the end of the current hypothesis.
  const maximumOverlap = Math.min(oldWords.length, newWords.length);
  for (let count = maximumOverlap; count >= 2; count--) {
    if (sameWords(oldWords.slice(oldWords.length - count), newWords.slice(0, count))) {
      return joinUniqueTranscript(previous, rawJoin(newTokens.slice(count)));
    }
  }
  return null;
}

/**
 * Holds completed interim windows separately from the one hypothesis Gemini is
 * still revising, so a revised tail is never appended repeatedly.
 */
export class InterimTranscriptAccumulator {
  private committed = "";
  private active = "";

  get text(): string {
    return joinUniqueTranscript(this.committed, this.active);
  }

  accept(update: string): string {
    const incoming = update.trim();
    if (!incoming) return this.text;
    if (!this.active) {
      this.active = incoming;
      return this.text;
    }
    const reconciled = reconcileHypothesis(this.active, incoming);
    if (reconciled !== null) {
      this.active = reconciled;
      return this.text;
    }
    // Unrelated text means the active hypothesis was preceding speech: commit it so
    // earlier words survive the new window.
    this.committed = joinUniqueTranscript(this.committed, this.active);
    this.active = incoming;
    return this.text;
  }

  reset(): void {
    this.committed = "";
    this.active = "";
  }
}

function comparisonWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean);
}

/**
 * Same sentence re-recognized with different words (a recognizer self-correction)
 * rather than genuinely new speech. Exact resends are caught by containment checks;
 * this catches same-length rewordings and prefix/suffix-anchored revisions.
 */
export function isRevisionReplacement(last: string, incoming: string): boolean {
  const oldWords = comparisonWords(last);
  const newWords = comparisonWords(incoming);
  if (oldWords.length === 0 || newWords.length === 0) return false;

  // Same word count with at least 90% of positions matching: a rewording, not new words.
  if (oldWords.length === newWords.length) {
    let equal = 0;
    for (let index = 0; index < oldWords.length; index++) if (oldWords[index] === newWords[index]) equal++;
    if (equal * 10 >= oldWords.length * 9) return true;
  }

  let prefix = 0;
  while (prefix < Math.min(oldWords.length, newWords.length) && oldWords[prefix] === newWords[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < Math.min(oldWords.length - prefix, newWords.length - prefix) &&
    oldWords[oldWords.length - 1 - suffix] === newWords[newWords.length - 1 - suffix]
  ) {
    suffix++;
  }
  return prefix >= 2 && suffix >= 2 && prefix + suffix >= Math.ceil(Math.min(oldWords.length, newWords.length) * 0.6);
}

export interface TranscriptSegment {
  text: string;
  at: number;
}

/**
 * Tracks one Live transcription stream: interim hypotheses are merged, finals are
 * deduplicated against server resends and revisions replace the previous segment.
 */
export class LiveTranscriptTracker {
  private readonly accumulator = new InterimTranscriptAccumulator();
  private lastFinal = "";
  readonly segments: TranscriptSegment[] = [];

  get interimText(): string {
    return this.accumulator.text;
  }

  get committedText(): string {
    return this.segments.map((segment) => segment.text).join(" ");
  }

  /** Merge an interim hypothesis; returns the current merged interim text. */
  acceptInterim(text: string): string {
    return this.accumulator.accept(text);
  }

  /**
   * Accept a final transcript. Returns the segment text to display, or null when the
   * server resent text the tracker already holds.
   */
  acceptFinal(text: string, at = Date.now()): { text: string; replaced: boolean } | null {
    const accumulated = this.accumulator.text;
    const fullText = isRevisionReplacement(accumulated, text) ? text.trim() : joinUniqueTranscript(accumulated, text);
    this.accumulator.reset();
    if (!fullText) return null;

    const normalizedNew = normalizeTranscript(fullText);
    const normalizedLast = normalizeTranscript(this.lastFinal);
    if (normalizedLast && (normalizedNew === normalizedLast || normalizedLast.includes(normalizedNew))) return null;
    this.lastFinal = fullText;

    const last = this.segments[this.segments.length - 1];
    if (last && isRevisionReplacement(last.text, fullText)) {
      last.text = fullText;
      return { text: fullText, replaced: true };
    }
    this.segments.push({ text: fullText, at });
    return { text: fullText, replaced: false };
  }

  /** Promote a dangling interim hypothesis (stream closed before its final). */
  flushInterim(at = Date.now()): string | null {
    const text = this.accumulator.text.trim();
    this.accumulator.reset();
    if (!text) return null;
    const normalizedText = normalizeTranscript(text);
    const normalizedLast = normalizeTranscript(this.lastFinal);
    if (normalizedText === normalizedLast || (normalizedLast && normalizedLast.includes(normalizedText))) return null;
    this.lastFinal = text;
    this.segments.push({ text, at });
    return text;
  }
}
