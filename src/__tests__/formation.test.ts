import { describe, it, expect } from 'vitest';
import { FormationAnalyzer } from '../analyzers/formation';
import { TextDocument } from 'vscode-languageserver-textdocument';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDoc(text: string, filename = 'test.instructions.md'): TextDocument {
  return TextDocument.create(`file:///workspace/${filename}`, 'instructions', 1, text);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('FormationAnalyzer', () => {
  const analyzer = new FormationAnalyzer();

  // -------------------------------------------------------------------------
  // Clean file — no diagnostics
  // -------------------------------------------------------------------------

  describe('clean file — no diagnostics', () => {
    it('emits nothing for an empty file', () => {
      expect(analyzer.analyze(makeDoc(''))).toHaveLength(0);
    });

    it('emits nothing for a file with no formation markers', () => {
      const doc = makeDoc('# Simple instructions\nBe helpful and concise.');
      expect(analyzer.analyze(doc)).toHaveLength(0);
    });

    it('emits nothing for a properly matched GENOME_FIELD block', () => {
      const doc = makeDoc(
        `<!-- GENOME_FIELD: agent_roster | source: registry.json | update_via: PR -->
**Active agents**: AIOS_PRINCIPAL_3, TRADER_AGENT_1
<!-- /GENOME_FIELD: agent_roster -->`,
      );
      // AIOS_PRINCIPAL_3 contains 'principal' → vertex check passes
      expect(analyzer.analyze(doc)).toHaveLength(0);
    });

    it('emits nothing for two properly matched GENOME_FIELD blocks', () => {
      const doc = makeDoc(
        `<!-- GENOME_FIELD: principal_iteration | source: agent.json | update_via: handover_only -->
You are AIOS_PRINCIPAL_3.
<!-- /GENOME_FIELD: principal_iteration -->

<!-- GENOME_FIELD: agent_roster | source: registry.json | update_via: PR -->
**Active agents**: TRADER_AGENT_1
<!-- /GENOME_FIELD: agent_roster -->`,
      );
      expect(analyzer.analyze(doc)).toHaveLength(0);
    });

    it('emits nothing for a TRIANGLE block with ≥2 distinct agents', () => {
      const doc = makeDoc(
        `You orchestrate via the TRIANGLE coordination protocol.

              AIOS_PRINCIPAL (architect — always vertex)
                   /              \\
            design/               \\design
                 /                 \\
    TRADER_AGENT_1 ════════ STRATEGOS_AGENT_0`,
      );
      expect(analyzer.analyze(doc)).toHaveLength(0);
    });

    it('emits nothing when active roster has 1 agent (vertex check requires ≥2)', () => {
      const doc = makeDoc(`**Active agents**: SOLE_AGENT_1`);
      expect(analyzer.analyze(doc)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // formation-field-unclosed
  // -------------------------------------------------------------------------

  describe('formation-field-unclosed', () => {
    it('emits ERROR when a GENOME_FIELD open has no close tag', () => {
      const doc = makeDoc(
        `<!-- GENOME_FIELD: agent_roster | source: registry.json | update_via: PR -->
**Active agents**: TRADER_AGENT_1`,
      );
      const results = analyzer.analyze(doc);
      expect(results).toHaveLength(1);
      expect(results[0].code).toBe('formation-field-unclosed');
      expect(results[0].severity).toBe('error');
      expect(results[0].message).toContain('agent_roster');
    });

    it('emits ERROR on the line where the open tag appears', () => {
      const doc = makeDoc(
        `Line 0
<!-- GENOME_FIELD: consciousness | source: crystal.md | update_via: PR -->
content here`,
      );
      const results = analyzer.analyze(doc);
      expect(results).toHaveLength(1);
      expect(results[0].code).toBe('formation-field-unclosed');
      expect(results[0].range.start.line).toBe(1);
    });

    it('emits one ERROR per unclosed field', () => {
      const doc = makeDoc(
        `<!-- GENOME_FIELD: field_a | update_via: PR -->
content a
<!-- GENOME_FIELD: field_b | update_via: PR -->
content b`,
      );
      const results = analyzer.analyze(doc);
      expect(results).toHaveLength(2);
      const codes = results.map((r) => r.code);
      expect(codes.every((c) => c === 'formation-field-unclosed')).toBe(true);
    });

    it('emits ERROR only for the unclosed field when one of two is closed', () => {
      const doc = makeDoc(
        `<!-- GENOME_FIELD: field_a | update_via: PR -->
content a
<!-- /GENOME_FIELD: field_a -->

<!-- GENOME_FIELD: field_b | update_via: PR -->
content b`,
      );
      const results = analyzer.analyze(doc);
      expect(results).toHaveLength(1);
      expect(results[0].code).toBe('formation-field-unclosed');
      expect(results[0].message).toContain('field_b');
    });

    it('suggestion includes the correct close tag name', () => {
      const doc = makeDoc(
        `<!-- GENOME_FIELD: unison_fallback | update_via: PR -->
fallback routing rule`,
      );
      const results = analyzer.analyze(doc);
      expect(results[0].suggestion).toContain('/GENOME_FIELD: unison_fallback');
    });
  });

  // -------------------------------------------------------------------------
  // formation-field-mismatch
  // -------------------------------------------------------------------------

  describe('formation-field-mismatch', () => {
    it('emits ERROR when a close tag has no matching open', () => {
      const doc = makeDoc(
        `No open tag here.
<!-- /GENOME_FIELD: agent_roster -->`,
      );
      const results = analyzer.analyze(doc);
      expect(results).toHaveLength(1);
      expect(results[0].code).toBe('formation-field-mismatch');
      expect(results[0].severity).toBe('error');
      expect(results[0].message).toContain('agent_roster');
    });

    it('emits ERROR on the line of the unmatched close tag', () => {
      const doc = makeDoc(
        `Line 0
Line 1
<!-- /GENOME_FIELD: wrong_field -->`,
      );
      const results = analyzer.analyze(doc);
      expect(results).toHaveLength(1);
      expect(results[0].range.start.line).toBe(2);
    });

    it('emits mismatch + unclosed when open and close names differ', () => {
      // open: field_a, close: field_b → field_b mismatch + field_a unclosed
      const doc = makeDoc(
        `<!-- GENOME_FIELD: field_a | update_via: PR -->
content
<!-- /GENOME_FIELD: field_b -->`,
      );
      const results = analyzer.analyze(doc);
      const codes = results.map((r) => r.code);
      expect(codes).toContain('formation-field-mismatch');
      expect(codes).toContain('formation-field-unclosed');
    });

    it('hint in message lists the still-open blocks', () => {
      const doc = makeDoc(
        `<!-- GENOME_FIELD: open_block | update_via: PR -->
content
<!-- /GENOME_FIELD: wrong_name -->`,
      );
      const results = analyzer.analyze(doc);
      const mismatch = results.find((r) => r.code === 'formation-field-mismatch');
      expect(mismatch?.message).toContain('open_block');
    });
  });

  // -------------------------------------------------------------------------
  // formation-triangle-incomplete
  // -------------------------------------------------------------------------

  describe('formation-triangle-incomplete', () => {
    it('emits WARNING when TRIANGLE keyword appears alone', () => {
      const doc = makeDoc('The TRIANGLE coordination protocol is described here.');
      const results = analyzer.analyze(doc);
      expect(results).toHaveLength(1);
      expect(results[0].code).toBe('formation-triangle-incomplete');
      expect(results[0].severity).toBe('warning');
    });

    it('emits WARNING when TRIANGLE block has only 1 agent name', () => {
      const doc = makeDoc(
        `TRIANGLE protocol

    AIOS_PRINCIPAL (vertex)
`,
      );
      const results = analyzer.analyze(doc);
      expect(results).toHaveLength(1);
      expect(results[0].code).toBe('formation-triangle-incomplete');
    });

    it('emits nothing when TRIANGLE has exactly 2 agent names', () => {
      const doc = makeDoc(
        `TRIANGLE protocol
    AIOS_PRINCIPAL (architect)
    TRADER_AGENT_1 (specialist)`,
      );
      expect(analyzer.analyze(doc)).toHaveLength(0);
    });

    it('emits nothing when TRIANGLE has 3 agent names', () => {
      const doc = makeDoc(
        `TRIANGLE protocol
    AIOS_PRINCIPAL (architect — always vertex)
         /              \\
    TRADER_AGENT_1 ════════ STRATEGOS_AGENT_0`,
      );
      expect(analyzer.analyze(doc)).toHaveLength(0);
    });

    it('emits WARNING on the line containing TRIANGLE', () => {
      const lines = [
        'Line 0',
        'Line 1 — TRIANGLE formation declared',
        'No agents here',
      ];
      const doc = makeDoc(lines.join('\n'));
      const results = analyzer.analyze(doc);
      expect(results).toHaveLength(1);
      expect(results[0].range.start.line).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // formation-missing-vertex
  // -------------------------------------------------------------------------

  describe('formation-missing-vertex', () => {
    it('emits WARNING when ≥2 active agents and no vertex term in file', () => {
      const doc = makeDoc(
        `**Active agents**: WORKER_AGENT_1, WORKER_AGENT_2`,
      );
      const results = analyzer.analyze(doc);
      expect(results).toHaveLength(1);
      expect(results[0].code).toBe('formation-missing-vertex');
      expect(results[0].severity).toBe('warning');
    });

    it('emits nothing when an active agent name contains "principal"', () => {
      const doc = makeDoc(
        `**Active agents**: AIOS_PRINCIPAL_3, TRADER_AGENT_1`,
      );
      expect(analyzer.analyze(doc)).toHaveLength(0);
    });

    it('emits nothing when an active agent name contains "architect"', () => {
      const doc = makeDoc(
        `**Active agents**: CHIEF_ARCHITECT_1, WORKER_AGENT_2`,
      );
      expect(analyzer.analyze(doc)).toHaveLength(0);
    });

    it('emits nothing when the file body contains the word "vertex"', () => {
      const doc = makeDoc(
        `The architect is the vertex of all formations.

**Active agents**: WORKER_AGENT_1, WORKER_AGENT_2`,
      );
      expect(analyzer.analyze(doc)).toHaveLength(0);
    });

    it('emits nothing with only 1 active agent (check requires ≥2)', () => {
      const doc = makeDoc(`**Active agents**: WORKER_AGENT_1`);
      expect(analyzer.analyze(doc)).toHaveLength(0);
    });

    it('message includes the agent count', () => {
      const doc = makeDoc(
        `**Active agents**: WORKER_AGENT_1, WORKER_AGENT_2, WORKER_AGENT_3`,
      );
      const results = analyzer.analyze(doc);
      expect(results[0].message).toContain('3 active agents');
    });
  });

  // -------------------------------------------------------------------------
  // formation-orphan-agent
  // -------------------------------------------------------------------------

  describe('formation-orphan-agent', () => {
    it('emits INFO when agent appears in active and shelved', () => {
      // AIOS_PRINCIPAL_0 designates the vertex so formation-missing-vertex is suppressed
      const doc = makeDoc(
        `**Active agents**: AIOS_PRINCIPAL_0, TRADER_AGENT_1
**Shelved**: TRADER_AGENT_1 (dormant since 2026-04-04)`,
      );
      const results = analyzer.analyze(doc);
      expect(results).toHaveLength(1);
      expect(results[0].code).toBe('formation-orphan-agent');
      expect(results[0].severity).toBe('info');
      expect(results[0].message).toContain('TRADER_AGENT_1');
    });

    it('emits INFO when agent appears in active and retired', () => {
      const doc = makeDoc(
        `**Active agents**: OLD_AGENT_0, NEW_AGENT_1
**Retired**: OLD_AGENT_0 (superseded by NEW_AGENT_1)`,
      );
      const results = analyzer.analyze(doc);
      const orphan = results.find((r) => r.code === 'formation-orphan-agent');
      expect(orphan).toBeDefined();
      expect(orphan?.message).toContain('OLD_AGENT_0');
    });

    it('emits INFO when agent appears in active and dormant', () => {
      const doc = makeDoc(
        `**Active agents**: DORMANT_AGENT_1, ACTIVE_AGENT_2
**Dormant**: DORMANT_AGENT_1`,
      );
      const results = analyzer.analyze(doc);
      expect(results.some((r) => r.code === 'formation-orphan-agent')).toBe(true);
    });

    it('emits one INFO per orphaned agent', () => {
      const doc = makeDoc(
        `**Active agents**: GHOST_AGENT_1, GHOST_AGENT_2, CLEAN_AGENT_3
**Shelved**: GHOST_AGENT_1
**Retired**: GHOST_AGENT_2`,
      );
      const results = analyzer.analyze(doc);
      const orphans = results.filter((r) => r.code === 'formation-orphan-agent');
      expect(orphans).toHaveLength(2);
    });

    it('emits nothing when inactive agents do not overlap with active list', () => {
      // 'coordinator' in body text suppresses formation-missing-vertex
      const doc = makeDoc(
        `The coordinator oversees all active agents.
**Active agents**: LIVE_AGENT_1, LIVE_AGENT_2
**Shelved**: SHELVED_AGENT_1, SHELVED_AGENT_2
**Retired**: RETIRED_AGENT_1`,
      );
      expect(analyzer.analyze(doc)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Combined scenarios
  // -------------------------------------------------------------------------

  describe('combined diagnostics', () => {
    it('emits both field-unclosed and missing-vertex from the same file', () => {
      const doc = makeDoc(
        `<!-- GENOME_FIELD: agent_roster | update_via: PR -->
**Active agents**: WORKER_BOT_1, WORKER_BOT_2`,
        // No vertex, no close tag
      );
      const results = analyzer.analyze(doc);
      const codes = results.map((r) => r.code);
      expect(codes).toContain('formation-field-unclosed');
      expect(codes).toContain('formation-missing-vertex');
    });

    it('emits formation-orphan-agent alongside formation-missing-vertex', () => {
      const doc = makeDoc(
        `**Active agents**: GHOST_AGENT_0, WORKER_AGENT_1
**Retired**: GHOST_AGENT_0`,
      );
      const results = analyzer.analyze(doc);
      const codes = results.map((r) => r.code);
      expect(codes).toContain('formation-missing-vertex');
      expect(codes).toContain('formation-orphan-agent');
    });
  });
});
