import { describe, it, expect } from 'vitest';
import { CascadeAnalyzer } from '../analyzers/cascade';
import { TextDocument } from 'vscode-languageserver-textdocument';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDoc(text: string, filename = 'test.instructions.md'): TextDocument {
  return TextDocument.create(`file:///workspace/${filename}`, 'instructions', 1, text);
}

function makeLines(n: number, content = 'Be helpful.'): string {
  return Array.from({ length: n }, () => content).join('\n');
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('CascadeAnalyzer', () => {
  const analyzer = new CascadeAnalyzer();

  // -------------------------------------------------------------------------
  // No diagnostic — clean files
  // -------------------------------------------------------------------------

  describe('clean file — no diagnostics', () => {
    it('emits nothing for a file with no cascade marker and no imports', () => {
      const doc = makeDoc('# Simple instructions\nBe helpful.');
      expect(analyzer.analyze(doc)).toHaveLength(0);
    });

    it('emits nothing for a GENOME tier file within the 150-line limit', () => {
      const body = makeLines(100);
      const doc = makeDoc(
        `<!-- AINLP.fractal[ZOOM] — This is the GENOME layer of the fractal knowledge cascade -->\n${body}`,
      );
      expect(analyzer.analyze(doc)).toHaveLength(0);
    });

    it('emits nothing for a CRYSTAL tier file within its 700-line limit', () => {
      const body = makeLines(500);
      const doc = makeDoc(
        `<!-- CASCADE_TIER: CRYSTAL -->\n${body}`,
        'AIOS_PRINCIPAL.crystal.md',
      );
      expect(analyzer.analyze(doc)).toHaveLength(0);
    });

    it('emits nothing for a file without a tier marker that imports prompt files', () => {
      const doc = makeDoc(
        '# Untimed file\n[Linked skill](./skills/helper.agent.md)',
      );
      // No tier marker → no cascade-invalid-order check; no self-import.
      expect(analyzer.analyze(doc)).toHaveLength(0);
    });

    it('emits nothing for a SKILL tier file importing a PROMPT file (SKILL > PROMPT)', () => {
      const doc = makeDoc(
        `<!-- CASCADE_TIER: SKILL -->\n[Template](./template.prompt.md)`,
        'SKILL.md',
      );
      expect(analyzer.analyze(doc)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // cascade-overflow
  // -------------------------------------------------------------------------

  describe('cascade-overflow', () => {
    it('emits WARNING when GENOME tier exceeds 150 lines', () => {
      const body = makeLines(160);
      const doc = makeDoc(
        `<!-- AINLP.fractal[ZOOM] — This is the GENOME layer of the fractal knowledge cascade -->\n${body}`,
      );
      const results = analyzer.analyze(doc);
      expect(results).toHaveLength(1);
      expect(results[0].code).toBe('cascade-overflow');
      expect(results[0].severity).toBe('warning');
    });

    it('emits WARNING when WORKSPACE tier exceeds 250 lines', () => {
      const body = makeLines(260);
      const doc = makeDoc(
        `<!-- CASCADE_TIER: WORKSPACE -->\n${body}`,
        'context.instructions.md',
      );
      const results = analyzer.analyze(doc);
      expect(results).toHaveLength(1);
      expect(results[0].code).toBe('cascade-overflow');
    });

    it('emits WARNING when SITUATION tier exceeds 400 lines', () => {
      const body = makeLines(410);
      const doc = makeDoc(
        `<!-- CASCADE_TIER: SITUATION -->\n${body}`,
        'DEV_PATH.md',
      );
      const results = analyzer.analyze(doc);
      expect(results).toHaveLength(1);
      expect(results[0].code).toBe('cascade-overflow');
    });

    it('does NOT emit cascade-overflow for tiers with no line limit (e.g. AGENT)', () => {
      const body = makeLines(800);
      const doc = makeDoc(
        `<!-- CASCADE_TIER: AGENT -->\n${body}`,
        'agent.agent.md',
      );
      expect(analyzer.analyze(doc)).toHaveLength(0);
    });

    it('overflow message includes the actual line count and tier limit', () => {
      const body = makeLines(160);
      const doc = makeDoc(
        `<!-- AINLP.fractal[ZOOM] — This is the GENOME layer of the fractal knowledge cascade -->\n${body}`,
      );
      const results = analyzer.analyze(doc);
      expect(results[0].message).toMatch(/161 lines/);
      expect(results[0].message).toMatch(/150/);
    });
  });

  // -------------------------------------------------------------------------
  // cascade-circular-reference
  // -------------------------------------------------------------------------

  describe('cascade-circular-reference', () => {
    it('emits ERROR when a file imports itself by name', () => {
      const doc = makeDoc(
        '# Self-referencing genome\n[Myself](./test.instructions.md)',
        'test.instructions.md',
      );
      const results = analyzer.analyze(doc);
      expect(results).toHaveLength(1);
      expect(results[0].code).toBe('cascade-circular-reference');
      expect(results[0].severity).toBe('error');
    });

    it('emits ERROR for self-import with a relative path prefix', () => {
      const doc = makeDoc(
        '# Self-link\n[Own genome](../workspace/test.agent.md)',
        'test.agent.md',
      );
      const results = analyzer.analyze(doc);
      expect(results).toHaveLength(1);
      expect(results[0].code).toBe('cascade-circular-reference');
    });

    it('does NOT emit circular-reference for imports of other files', () => {
      const doc = makeDoc(
        '# Genome\n[Crystal](./crystal.instructions.md)',
        'genome.instructions.md',
      );
      const results = analyzer.analyze(doc);
      expect(results.some((r) => r.code === 'cascade-circular-reference')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // cascade-invalid-order
  // -------------------------------------------------------------------------

  describe('cascade-invalid-order', () => {
    it('emits ERROR when a CRYSTAL tier file imports from GENOME tier', () => {
      const doc = makeDoc(
        `<!-- CASCADE_TIER: CRYSTAL -->\n[Genome](./copilot-instructions.md)`,
        'AIOS_PRINCIPAL.crystal.md',
      );
      const results = analyzer.analyze(doc);
      expect(results).toHaveLength(1);
      expect(results[0].code).toBe('cascade-invalid-order');
      expect(results[0].severity).toBe('error');
    });

    it('emits ERROR when a SKILL tier file imports from WORKSPACE tier', () => {
      const doc = makeDoc(
        `<!-- CASCADE_TIER: SKILL -->\n[Workspace context](./context.instructions.md)`,
        'SKILL.md',
      );
      const results = analyzer.analyze(doc);
      expect(results).toHaveLength(1);
      expect(results[0].code).toBe('cascade-invalid-order');
    });

    it('emits ERROR when a PROMPT tier file imports from AGENT tier', () => {
      const doc = makeDoc(
        `<!-- CASCADE_TIER: PROMPT -->\n[Agent](./mybot.agent.md)`,
        'template.prompt.md',
      );
      const results = analyzer.analyze(doc);
      expect(results).toHaveLength(1);
      expect(results[0].code).toBe('cascade-invalid-order');
    });

    it('does NOT emit invalid-order when import is from a lower-priority tier', () => {
      const doc = makeDoc(
        `<!-- CASCADE_TIER: CRYSTAL -->\n[Situation](./DEV_PATH.instructions.md)`,
        'knowledge.crystal.md',
      );
      // DEV_PATH.instructions.md → infers SITUATION tier (index 3); CRYSTAL is index 2.
      // SITUATION index (3) > CRYSTAL index (2) → import is going deeper, not higher → no violation.
      const results = analyzer.analyze(doc);
      expect(results.some((r) => r.code === 'cascade-invalid-order')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // cascade-missing-dependency
  // -------------------------------------------------------------------------

  describe('cascade-missing-dependency', () => {
    it('emits WARNING for imports with more than 3 upward traversals', () => {
      const doc = makeDoc(
        '# Deep link\n[Deep file](../../../../distant/helper.instructions.md)',
      );
      const results = analyzer.analyze(doc);
      expect(results).toHaveLength(1);
      expect(results[0].code).toBe('cascade-missing-dependency');
      expect(results[0].severity).toBe('warning');
    });

    it('does NOT emit missing-dependency for imports with 3 or fewer traversals', () => {
      const doc = makeDoc(
        '# Reasonable link\n[Near file](../../helper.instructions.md)',
      );
      const results = analyzer.analyze(doc);
      expect(results.some((r) => r.code === 'cascade-missing-dependency')).toBe(false);
    });

    it('missing-dependency message includes the path and traversal count', () => {
      const doc = makeDoc(
        '# Deep link\n[File](../../../../a/b.prompt.md)',
      );
      const results = analyzer.analyze(doc);
      expect(results[0].message).toMatch(/4/);
    });
  });

  // -------------------------------------------------------------------------
  // Tier marker detection
  // -------------------------------------------------------------------------

  describe('tier marker detection', () => {
    it('detects AINLP.fractal[ZOOM] GENOME marker', () => {
      const body = makeLines(200);
      const doc = makeDoc(
        `<!-- AINLP.fractal[ZOOM] — This is the GENOME layer of the fractal knowledge cascade -->\n${body}`,
      );
      const results = analyzer.analyze(doc);
      // Should produce overflow (200 > 150) but no other errors.
      expect(results[0].code).toBe('cascade-overflow');
      expect(results[0].message).toMatch(/GENOME/);
    });

    it('detects explicit CASCADE_TIER: FABRIC marker', () => {
      const body = makeLines(600);
      const doc = makeDoc(
        `<!-- CASCADE_TIER: FABRIC -->\n${body}`,
        'AIOS_CONSCIOUSNESS_FABRIC.md',
      );
      const results = analyzer.analyze(doc);
      // 601 lines > 500 limit for FABRIC
      expect(results).toHaveLength(1);
      expect(results[0].code).toBe('cascade-overflow');
      expect(results[0].message).toMatch(/FABRIC/);
    });

    it('treats an unknown tier name as UNKNOWN and emits no overflow', () => {
      const body = makeLines(200);
      const doc = makeDoc(`<!-- CASCADE_TIER: QUATTUORDECILLION -->\n${body}`);
      // UNKNOWN tier has no line limit → no cascade-overflow
      expect(analyzer.analyze(doc)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Multiple diagnostics in one file
  // -------------------------------------------------------------------------

  describe('multiple diagnostics', () => {
    it('emits both overflow and circular-reference from a single file', () => {
      const body = makeLines(160);
      const doc = makeDoc(
        `<!-- AINLP.fractal[ZOOM] — This is the GENOME layer of the fractal knowledge cascade -->\n${body}\n[Self](./test.instructions.md)`,
        'test.instructions.md',
      );
      const results = analyzer.analyze(doc);
      const codes = results.map((r) => r.code);
      expect(codes).toContain('cascade-overflow');
      expect(codes).toContain('cascade-circular-reference');
    });

    it('all results carry analyzer = "cascade"', () => {
      const body = makeLines(160);
      const doc = makeDoc(
        `<!-- AINLP.fractal[ZOOM] — This is the GENOME layer of the fractal knowledge cascade -->\n${body}`,
      );
      const results = analyzer.analyze(doc);
      expect(results.every((r) => r.analyzer === 'cascade')).toBe(true);
    });
  });
});
