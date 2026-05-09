import { describe, it, expect } from 'vitest';
import { VitalityAnalyzer } from '../analyzers/vitality';
import { TextDocument } from 'vscode-languageserver-textdocument';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDoc(text: string, langId = 'instructions'): TextDocument {
  return TextDocument.create(`file:///test.instructions.md`, langId, 1, text);
}

/**
 * Returns a Date that is `days` days in the past (relative to `base`).
 * Used to generate last_touched values without hard-coding absolute dates.
 */
function daysAgo(days: number, base: Date = TODAY): Date {
  const d = new Date(base);
  d.setDate(d.getDate() - days);
  return d;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Fixed "today" so tests are deterministic. */
const TODAY = new Date('2026-05-09T00:00:00Z');

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('VitalityAnalyzer', () => {
  const analyzer = new VitalityAnalyzer();

  // -------------------------------------------------------------------------
  // No diagnostic — fresh files
  // -------------------------------------------------------------------------

  describe('fresh file — no diagnostics', () => {
    it('emits nothing when the file is within the stale window', () => {
      const touched = isoDate(daysAgo(10));
      const doc = makeDoc(
        `<!-- VITALITY: { "last_touched": "${touched}", "stale_after_days": 30 } -->
# My Agent\nBe helpful.`,
      );
      const results = analyzer.analyze(doc, TODAY);
      expect(results).toHaveLength(0);
    });

    it('emits nothing when exactly at the stale threshold', () => {
      const touched = isoDate(daysAgo(30));
      const doc = makeDoc(
        `<!-- VITALITY: { "last_touched": "${touched}", "stale_after_days": 30 } -->`,
      );
      const results = analyzer.analyze(doc, TODAY);
      expect(results).toHaveLength(0);
    });

    it('emits nothing when file has no imports and no VITALITY tag', () => {
      const doc = makeDoc('# Plain instructions file\nBe helpful.');
      const results = analyzer.analyze(doc, TODAY);
      expect(results).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // vitality-stale
  // -------------------------------------------------------------------------

  describe('vitality-stale', () => {
    it('emits WARNING when days_elapsed > stale_after_days', () => {
      const touched = isoDate(daysAgo(45));
      const doc = makeDoc(
        `<!-- VITALITY: { "last_touched": "${touched}", "stale_after_days": 30 } -->`,
      );
      const results = analyzer.analyze(doc, TODAY);
      expect(results).toHaveLength(1);
      expect(results[0].code).toBe('vitality-stale');
      expect(results[0].severity).toBe('warning');
    });

    it('includes the update_trigger hint in the message', () => {
      const touched = isoDate(daysAgo(45));
      const doc = makeDoc(
        `<!-- VITALITY: { "last_touched": "${touched}", "stale_after_days": 30, "update_trigger": "on API change" } -->`,
      );
      const results = analyzer.analyze(doc, TODAY);
      expect(results[0].message).toContain('on API change');
    });

    it('uses DEFAULT_STALE_DAYS (90) when stale_after_days is omitted', () => {
      const touched = isoDate(daysAgo(100));
      const doc = makeDoc(
        `<!-- VITALITY: { "last_touched": "${touched}" } -->`,
      );
      const results = analyzer.analyze(doc, TODAY);
      // 100 > 90 but 100 < 180 → stale (not expired)
      expect(results).toHaveLength(1);
      expect(results[0].code).toBe('vitality-stale');
    });
  });

  // -------------------------------------------------------------------------
  // vitality-expired
  // -------------------------------------------------------------------------

  describe('vitality-expired', () => {
    it('emits ERROR when days_elapsed > stale_after_days * 2', () => {
      const touched = isoDate(daysAgo(65));
      const doc = makeDoc(
        `<!-- VITALITY: { "last_touched": "${touched}", "stale_after_days": 30 } -->`,
      );
      const results = analyzer.analyze(doc, TODAY);
      expect(results).toHaveLength(1);
      expect(results[0].code).toBe('vitality-expired');
      expect(results[0].severity).toBe('error');
    });

    it('includes a suggestion with today\'s date', () => {
      const touched = isoDate(daysAgo(65));
      const doc = makeDoc(
        `<!-- VITALITY: { "last_touched": "${touched}", "stale_after_days": 30 } -->`,
      );
      const results = analyzer.analyze(doc, TODAY);
      expect(results[0].suggestion).toContain('2026-05-09');
    });

    it('includes elapsed days in the message', () => {
      const touched = isoDate(daysAgo(65));
      const doc = makeDoc(
        `<!-- VITALITY: { "last_touched": "${touched}", "stale_after_days": 30 } -->`,
      );
      const results = analyzer.analyze(doc, TODAY);
      expect(results[0].message).toContain('65 days');
    });
  });

  // -------------------------------------------------------------------------
  // vitality-missing
  // -------------------------------------------------------------------------

  describe('vitality-missing', () => {
    it('emits INFO when file imports another prompt file but has no VITALITY tag', () => {
      const doc = makeDoc(
        `# Composition\n\nThis file imports [base.instructions.md](./base.instructions.md).`,
      );
      const results = analyzer.analyze(doc, TODAY);
      expect(results).toHaveLength(1);
      expect(results[0].code).toBe('vitality-missing');
      expect(results[0].severity).toBe('info');
    });

    it('does NOT emit vitality-missing when VITALITY tag is present', () => {
      const touched = isoDate(daysAgo(5));
      const doc = makeDoc(
        `<!-- VITALITY: { "last_touched": "${touched}", "stale_after_days": 30 } -->\n` +
          `[base.instructions.md](./base.instructions.md)`,
      );
      const results = analyzer.analyze(doc, TODAY);
      expect(results.some((r) => r.code === 'vitality-missing')).toBe(false);
    });

    it('does NOT emit vitality-missing for imports of non-prompt files', () => {
      const doc = makeDoc(
        `See [README](./README.md) and [schema](./schema.json) for more.`,
      );
      const results = analyzer.analyze(doc, TODAY);
      expect(results).toHaveLength(0);
    });

    it('emits on line 0', () => {
      const doc = makeDoc(
        `[agent.instructions.md](./agent.instructions.md)`,
      );
      const results = analyzer.analyze(doc, TODAY);
      expect(results[0].range.start.line).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // vitality-malformed
  // -------------------------------------------------------------------------

  describe('vitality-malformed', () => {
    it('emits WARNING when VITALITY comment has invalid JSON', () => {
      const doc = makeDoc(
        `<!-- VITALITY: { last_touched: 2026-01-01 } -->`,
      );
      const results = analyzer.analyze(doc, TODAY);
      expect(results).toHaveLength(1);
      expect(results[0].code).toBe('vitality-malformed');
      expect(results[0].severity).toBe('warning');
    });

    it('continues processing subsequent VITALITY tags after a malformed one', () => {
      const touched = isoDate(daysAgo(5));
      const doc = makeDoc(
        `<!-- VITALITY: { bad json } -->\n` +
          `<!-- VITALITY: { "last_touched": "${touched}", "stale_after_days": 30 } -->`,
      );
      const results = analyzer.analyze(doc, TODAY);
      // First tag → malformed; second tag → fresh (no stale/expired)
      expect(results).toHaveLength(1);
      expect(results[0].code).toBe('vitality-malformed');
    });
  });

  // -------------------------------------------------------------------------
  // vitality-no-date
  // -------------------------------------------------------------------------

  describe('vitality-no-date', () => {
    it('emits INFO when last_touched is missing', () => {
      const doc = makeDoc(
        `<!-- VITALITY: { "owner": "team", "stale_after_days": 30 } -->`,
      );
      const results = analyzer.analyze(doc, TODAY);
      expect(results).toHaveLength(1);
      expect(results[0].code).toBe('vitality-no-date');
      expect(results[0].severity).toBe('info');
    });
  });

  // -------------------------------------------------------------------------
  // vitality-invalid-date
  // -------------------------------------------------------------------------

  describe('vitality-invalid-date', () => {
    it('emits WARNING when last_touched is not a valid ISO date', () => {
      const doc = makeDoc(
        `<!-- VITALITY: { "last_touched": "not-a-date", "stale_after_days": 30 } -->`,
      );
      const results = analyzer.analyze(doc, TODAY);
      expect(results).toHaveLength(1);
      expect(results[0].code).toBe('vitality-invalid-date');
      expect(results[0].severity).toBe('warning');
    });

    it('includes the bad date value in the message', () => {
      const doc = makeDoc(
        `<!-- VITALITY: { "last_touched": "32/13/2026", "stale_after_days": 30 } -->`,
      );
      const results = analyzer.analyze(doc, TODAY);
      expect(results[0].message).toContain('32/13/2026');
    });
  });

  // -------------------------------------------------------------------------
  // Line number accuracy
  // -------------------------------------------------------------------------

  describe('line number accuracy', () => {
    it('reports the VITALITY tag on the correct line', () => {
      const touched = isoDate(daysAgo(45));
      const doc = makeDoc(
        `# Title\n# Subtitle\n<!-- VITALITY: { "last_touched": "${touched}", "stale_after_days": 30 } -->`,
      );
      const results = analyzer.analyze(doc, TODAY);
      expect(results).toHaveLength(1);
      expect(results[0].range.start.line).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Multiple tags
  // -------------------------------------------------------------------------

  describe('multiple VITALITY tags', () => {
    it('handles multiple tags in the same document independently', () => {
      const stale = isoDate(daysAgo(50));
      const fresh = isoDate(daysAgo(5));
      const doc = makeDoc(
        `<!-- VITALITY: { "last_touched": "${stale}", "stale_after_days": 30 } -->\n` +
          `<!-- VITALITY: { "last_touched": "${fresh}", "stale_after_days": 30 } -->`,
      );
      const results = analyzer.analyze(doc, TODAY);
      // First → stale; second → fresh (no diagnostic)
      expect(results).toHaveLength(1);
      expect(results[0].code).toBe('vitality-stale');
      expect(results[0].range.start.line).toBe(0);
    });
  });
});
