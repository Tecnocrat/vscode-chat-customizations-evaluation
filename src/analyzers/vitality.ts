import { TextDocument } from 'vscode-languageserver-textdocument';
import { AnalysisResult } from '../types';

/**
 * VITALITY tag — a machine-readable governance annotation for agent instruction files.
 *
 * Format (embedded in an HTML comment so it doesn't affect prompt content):
 *
 *   <!-- VITALITY: { "owner": "team", "last_touched": "YYYY-MM-DD",
 *                    "stale_after_days": 30,
 *                    "update_trigger": "when linked files change" } -->
 *
 * Rules:
 *   - stale  (WARNING) : days_elapsed > stale_after_days
 *   - expired (ERROR)  : days_elapsed > stale_after_days * 2
 *   - missing (INFO)   : file imports other prompt files but has no VITALITY tag
 */
interface VitalityTag {
  /** Author or team responsible for keeping this file current. */
  owner?: string;
  /** ISO 8601 date (YYYY-MM-DD) of the last intentional review/update. */
  last_touched?: string;
  /** Number of days before the file is considered stale. Defaults to 90. */
  stale_after_days?: number;
  /** Human-readable hint describing what should trigger a review. */
  update_trigger?: string;
}

/**
 * Pure-syntax analyzer that detects stale or expired agent instruction files
 * using VITALITY frontmatter tags.  No LLM call required — always runs.
 */
export class VitalityAnalyzer {
  /** Pattern matching a single VITALITY comment block. */
  private static readonly VITALITY_COMMENT_RE = /<!--\s*VITALITY\s*:\s*(\{[\s\S]*?\})\s*-->/g;

  /** Prompt/agent file extensions recognised as "importable". */
  private static readonly PROMPT_EXTENSIONS = ['.prompt.md', '.agent.md', '.instructions.md'];

  /**
   * Default stale threshold when the tag omits `stale_after_days`.
   * 90 days is a reasonable cadence for most instruction files.
   */
  private static readonly DEFAULT_STALE_DAYS = 90;

  /**
   * Analyse a document for VITALITY tag issues.
   *
   * @param doc       The document under analysis.
   * @param now       Override "today" (ISO string or Date) — used in tests.
   * @returns         Array of AnalysisResult diagnostics (may be empty).
   */
  analyze(doc: TextDocument, now: Date = new Date()): AnalysisResult[] {
    const text = doc.getText();
    const lines = text.split('\n');
    const results: AnalysisResult[] = [];
    let vitalityTagFound = false;

    const re = new RegExp(VitalityAnalyzer.VITALITY_COMMENT_RE.source, 'g');
    let match: RegExpExecArray | null;

    while ((match = re.exec(text)) !== null) {
      vitalityTagFound = true;
      const tagJson = match[1];

      // Resolve line number and character offsets.
      const lineNum = text.slice(0, match.index).split('\n').length - 1;
      const lineContent = lines[lineNum] ?? '';

      // Parse the embedded JSON.
      let tag: VitalityTag;
      try {
        tag = JSON.parse(tagJson) as VitalityTag;
      } catch {
        results.push(this.makeResult(
          'vitality-malformed',
          'VITALITY tag contains invalid JSON. Check the syntax of the comment.',
          'warning',
          lineNum,
          lineContent,
          'Fix the JSON in the VITALITY comment (use double-quoted keys, no trailing commas).',
        ));
        continue;
      }

      // Require last_touched.
      if (!tag.last_touched) {
        results.push(this.makeResult(
          'vitality-no-date',
          'VITALITY tag is missing the required "last_touched" field. Add "last_touched": "YYYY-MM-DD".',
          'info',
          lineNum,
          lineContent,
          `Add "last_touched": "${this.todayISO(now)}" to the VITALITY comment.`,
        ));
        continue;
      }

      // Validate date format.
      const lastTouched = new Date(tag.last_touched);
      if (isNaN(lastTouched.getTime())) {
        results.push(this.makeResult(
          'vitality-invalid-date',
          `VITALITY tag has an invalid "last_touched" date: "${tag.last_touched}". Use YYYY-MM-DD format.`,
          'warning',
          lineNum,
          lineContent,
          `Correct the date to a valid ISO 8601 string, e.g. "${this.todayISO(now)}".`,
        ));
        continue;
      }

      // Compute staleness.
      const staleAfterDays = tag.stale_after_days ?? VitalityAnalyzer.DEFAULT_STALE_DAYS;
      const daysElapsed = Math.floor(
        (now.getTime() - lastTouched.getTime()) / (1000 * 60 * 60 * 24),
      );
      const triggerHint = tag.update_trigger
        ? ` Update trigger: \"${tag.update_trigger}\".`
        : '';
      const suggestion = `Review the content and update "last_touched" to "${this.todayISO(now)}".`;

      if (daysElapsed > staleAfterDays * 2) {
        results.push(this.makeResult(
          'vitality-expired',
          `File is EXPIRED — ${daysElapsed} days since last review (threshold: ${staleAfterDays} days, expiry: ${staleAfterDays * 2} days).${triggerHint} Update "last_touched" after reviewing.`,
          'error',
          lineNum,
          lineContent,
          suggestion,
        ));
      } else if (daysElapsed > staleAfterDays) {
        results.push(this.makeResult(
          'vitality-stale',
          `File may be STALE — ${daysElapsed} days since last review (threshold: ${staleAfterDays} days).${triggerHint} Review whether the content still reflects current behaviour.`,
          'warning',
          lineNum,
          lineContent,
          suggestion,
        ));
      }
      // No diagnostic when daysElapsed <= staleAfterDays (file is fresh).
    }

    // Recommend adding a VITALITY tag when the file imports other prompt files.
    if (!vitalityTagFound && this.hasPromptImports(text)) {
      const addExample = `<!-- VITALITY: { "owner": "author", "last_touched": "${this.todayISO(now)}", "stale_after_days": 30, "update_trigger": "when linked files change" } -->`;
      results.push(this.makeResult(
        'vitality-missing',
        'This file imports other prompt files but has no VITALITY tag. Files that compose other prompts should declare their review cadence.',
        'info',
        0,
        lines[0] ?? '',
        `Add near the top: ${addExample}`,
      ));
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Returns true when the document links to any recognised prompt file. */
  private hasPromptImports(text: string): boolean {
    const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(text)) !== null) {
      const target = m[2].trim().split('#')[0];
      if (
        VitalityAnalyzer.PROMPT_EXTENSIONS.some((ext) =>
          target.toLowerCase().endsWith(ext),
        )
      ) {
        return true;
      }
    }
    return false;
  }

  /** Returns today as a YYYY-MM-DD string. */
  private todayISO(now: Date): string {
    return now.toISOString().slice(0, 10);
  }

  /** Construct an AnalysisResult with accurate character offsets. */
  private makeResult(
    code: string,
    message: string,
    severity: 'error' | 'warning' | 'info' | 'hint',
    lineNum: number,
    lineContent: string,
    suggestion?: string,
  ): AnalysisResult {
    return {
      code,
      message,
      severity,
      range: {
        start: { line: lineNum, character: 0 },
        end: { line: lineNum, character: lineContent.length },
      },
      analyzer: 'vitality',
      suggestion,
    };
  }
}
