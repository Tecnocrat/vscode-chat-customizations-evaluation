import { TextDocument } from 'vscode-languageserver-textdocument';
import { AnalysisResult } from '../types';

/**
 * FORMATION — detects multi-agent coordination issues in agent instruction files.
 *
 * Recognises three syntactic structures:
 *
 * 1. GENOME_FIELD blocks (AIOS convention):
 *
 *   <!-- GENOME_FIELD: field_name | source: ... | update_via: PR | auto_govern: true -->
 *   ...field content...
 *   <!-- /GENOME_FIELD: field_name -->
 *
 * 2. Agent roster lines:
 *
 *   **Active agents**: AGENT_A, AGENT_B
 *   **Shelved**: AGENT_C (dormant since 2026-04-04)
 *   **Retired**: AGENT_D (superseded by AGENT_E)
 *
 * 3. TRIANGLE formation keyword (AIOS TRIANGLE coordination protocol):
 *
 *   TRIANGLE formation declared with at least 1 vertex and 1 base agent.
 *
 * Diagnostics emitted:
 *   - formation-field-unclosed      (ERROR)   : GENOME_FIELD block opened but never closed
 *   - formation-field-mismatch      (ERROR)   : close tag name has no matching open block
 *   - formation-missing-vertex      (WARNING) : multi-agent roster has no vertex/principal designated
 *   - formation-triangle-incomplete (WARNING) : TRIANGLE keyword with <2 distinct agents declared
 *   - formation-orphan-agent        (INFO)    : agent appears in both active and inactive lists
 */

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface FieldBlock {
  name: string;
  lineNum: number;
  lineContent: string;
  /** Set to true once a matching close tag is found. */
  used: boolean;
}

interface FieldClose {
  name: string;
  lineNum: number;
  lineContent: string;
}

interface AgentEntry {
  name: string;
  lineNum: number;
  lineContent: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Terms that identify a vertex/coordinator/architect role. */
const VERTEX_TERMS: readonly string[] = [
  'vertex',
  'architect',
  'principal',
  'coordinator',
  'orchestrator',
];

// ---------------------------------------------------------------------------
// Analyzer
// ---------------------------------------------------------------------------

/**
 * Pure-syntax analyzer that validates multi-agent formation structure in
 * agent instruction files.  No LLM call required — always runs.
 */
export class FormationAnalyzer {
  /** Matches GENOME_FIELD opening tags.  Group 1 = field name. */
  private static readonly FIELD_OPEN_RE =
    /<!--\s*GENOME_FIELD\s*:\s*([\w_-]+)[^>]*-->/g;

  /** Matches GENOME_FIELD closing tags.  Group 1 = field name. */
  private static readonly FIELD_CLOSE_RE =
    /<!--\s*\/GENOME_FIELD\s*:\s*([\w_-]+)\s*-->/g;

  /** Matches the TRIANGLE keyword as a whole word (case-sensitive). */
  private static readonly TRIANGLE_RE = /\bTRIANGLE\b/;

  /**
   * Matches agent roster section headers.
   * Group 1 = status label (Active agents, Shelved, Retired, Dormant, Deprecated).
   * Group 2 = remainder of the line (the agent names).
   */
  private static readonly ROSTER_RE_SOURCE =
    /^\*\*(Active agents?|Shelved|Retired|Dormant|Deprecated)\**\s*:\s*(.+)/im.source;

  /**
   * All-caps agent name pattern (e.g. TRADER_AGENT_1, AIOS_PRINCIPAL_3).
   * Requires at least one underscore separator to avoid matching single words
   * like README or DONE.
   */
  private static readonly AGENT_NAME_RE_SOURCE =
    /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g.source;

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Analyse a document for multi-agent formation issues.
   *
   * @param doc  The document under analysis.
   * @returns    Array of AnalysisResult diagnostics (may be empty).
   */
  analyze(doc: TextDocument): AnalysisResult[] {
    const text = doc.getText();
    const lines = text.split('\n');
    return [
      ...this.checkGenomeFields(text, lines),
      ...this.checkTriangle(text, lines),
      ...this.checkRoster(text, lines),
    ];
  }

  // ---------------------------------------------------------------------------
  // GENOME_FIELD block integrity
  // ---------------------------------------------------------------------------

  private checkGenomeFields(text: string, lines: string[]): AnalysisResult[] {
    const results: AnalysisResult[] = [];

    // --- Collect all open tags ---
    const opens: FieldBlock[] = [];
    {
      const re = new RegExp(FormationAnalyzer.FIELD_OPEN_RE.source, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const lineNum = text.slice(0, m.index).split('\n').length - 1;
        opens.push({
          name: m[1],
          lineNum,
          lineContent: lines[lineNum] ?? '',
          used: false,
        });
      }
    }

    // --- Collect all close tags ---
    const closes: FieldClose[] = [];
    {
      const re = new RegExp(FormationAnalyzer.FIELD_CLOSE_RE.source, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const lineNum = text.slice(0, m.index).split('\n').length - 1;
        closes.push({ name: m[1], lineNum, lineContent: lines[lineNum] ?? '' });
      }
    }

    // --- Match each close tag to the first unused open of the same name ---
    for (const close of closes) {
      let found = false;
      for (const open of opens) {
        if (!open.used && open.name === close.name && open.lineNum < close.lineNum) {
          open.used = true;
          found = true;
          break;
        }
      }
      if (!found) {
        // Close tag with no matching open → mismatch.
        const pendingNames = opens
          .filter((o) => !o.used)
          .map((o) => `"${o.name}"`)
          .join(', ');
        const hint = pendingNames
          ? ` Unclosed GENOME_FIELD blocks: ${pendingNames}.`
          : '';
        results.push(
          this.makeResult(
            'formation-field-mismatch',
            `GENOME_FIELD close tag for "${close.name}" has no matching open tag.${hint}`,
            'error',
            close.lineNum,
            close.lineContent,
            `Add <!-- GENOME_FIELD: ${close.name} | ... --> before the field content, ` +
              `or correct the close tag to match an existing open block.`,
          ),
        );
      }
    }

    // --- Any open block that was never matched → unclosed ---
    for (const open of opens) {
      if (!open.used) {
        results.push(
          this.makeResult(
            'formation-field-unclosed',
            `GENOME_FIELD "${open.name}" is opened but never closed. ` +
              `Each GENOME_FIELD block must end with <!-- /GENOME_FIELD: ${open.name} -->.`,
            'error',
            open.lineNum,
            open.lineContent,
            `Add <!-- /GENOME_FIELD: ${open.name} --> after the field content.`,
          ),
        );
      }
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // TRIANGLE formation completeness
  // ---------------------------------------------------------------------------

  private checkTriangle(text: string, lines: string[]): AnalysisResult[] {
    const results: AnalysisResult[] = [];

    const triangleMatch = FormationAnalyzer.TRIANGLE_RE.exec(text);
    if (!triangleMatch) return results;

    const triangleLineNum = text.slice(0, triangleMatch.index).split('\n').length - 1;
    const triangleLineContent = lines[triangleLineNum] ?? '';

    // Scan a window of lines around the TRIANGLE keyword for agent names.
    const windowStart = Math.max(0, triangleLineNum - 2);
    const windowEnd = Math.min(lines.length, triangleLineNum + 20);
    const window = lines.slice(windowStart, windowEnd).join('\n');

    const agentNames = new Set<string>();
    const re = new RegExp(FormationAnalyzer.AGENT_NAME_RE_SOURCE, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(window)) !== null) {
      agentNames.add(m[1]);
    }

    if (agentNames.size < 2) {
      results.push(
        this.makeResult(
          'formation-triangle-incomplete',
          `TRIANGLE formation keyword found but only ${agentNames.size} distinct agent ` +
            `name(s) declared nearby (minimum 2 required for a valid formation). ` +
            `A TRIANGLE requires at least 1 vertex agent and 1 base agent.`,
          'warning',
          triangleLineNum,
          triangleLineContent,
          'Declare at least 2 all-caps agent names in the TRIANGLE block ' +
            '(e.g. AIOS_PRINCIPAL and TRADER_AGENT_1).',
        ),
      );
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Roster integrity
  // ---------------------------------------------------------------------------

  private checkRoster(text: string, lines: string[]): AnalysisResult[] {
    const results: AnalysisResult[] = [];

    const activeAgents: AgentEntry[] = [];
    const inactiveAgents: AgentEntry[] = [];

    // Parse all roster section lines.
    const rosterRe = new RegExp(FormationAnalyzer.ROSTER_RE_SOURCE, 'gim');
    let m: RegExpExecArray | null;
    while ((m = rosterRe.exec(text)) !== null) {
      // Normalise the status label: strip trailing "agents?" and lower-case.
      const statusLabel = m[1].toLowerCase().replace(/\s+agents?$/, '');
      const rest = m[2];
      const lineNum = text.slice(0, m.index).split('\n').length - 1;
      const lineContent = lines[lineNum] ?? '';
      const isActive = statusLabel === 'active';

      const nameRe = new RegExp(FormationAnalyzer.AGENT_NAME_RE_SOURCE, 'g');
      let n: RegExpExecArray | null;
      while ((n = nameRe.exec(rest)) !== null) {
        const entry: AgentEntry = { name: n[1], lineNum, lineContent };
        if (isActive) {
          activeAgents.push(entry);
        } else {
          inactiveAgents.push(entry);
        }
      }
    }

    if (activeAgents.length + inactiveAgents.length === 0) return results;

    // --- Check 1: missing vertex when ≥2 active agents are declared ---
    if (activeAgents.length >= 2) {
      const agentNamesLower = activeAgents.map((a) => a.name.toLowerCase());
      // Also scan the document body for any explicit vertex designation text.
      const bodyLower = text.toLowerCase();
      const hasVertex =
        agentNamesLower.some((n) => VERTEX_TERMS.some((vt) => n.includes(vt))) ||
        VERTEX_TERMS.some((vt) => bodyLower.includes(vt));

      if (!hasVertex) {
        results.push(
          this.makeResult(
            'formation-missing-vertex',
            `Multi-agent roster lists ${activeAgents.length} active agents but no vertex ` +
              `(architect/principal/coordinator) is designated. Every agent formation ` +
              `requires exactly one vertex that orchestrates the other agents.`,
            'warning',
            activeAgents[0].lineNum,
            activeAgents[0].lineContent,
            'Mark one agent as the vertex, e.g. append "(architect — always vertex)" or add ' +
              '"PRINCIPAL: AGENT_X" to clarify the formation hierarchy.',
          ),
        );
      }
    }

    // --- Check 2: orphan agents — appear in both active and inactive lists ---
    const activeNames = new Set(activeAgents.map((a) => a.name));
    for (const inactive of inactiveAgents) {
      if (activeNames.has(inactive.name)) {
        results.push(
          this.makeResult(
            'formation-orphan-agent',
            `Agent "${inactive.name}" is listed as both active and inactive ` +
              `(appears in the active roster and in a shelved/retired/dormant section). ` +
              `An agent can hold only one status at a time.`,
            'info',
            inactive.lineNum,
            inactive.lineContent,
            `Remove "${inactive.name}" from the active list, or update the ` +
              `inactive section to reflect the current formation state.`,
          ),
        );
      }
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Shared helper
  // ---------------------------------------------------------------------------

  private makeResult(
    code: string,
    message: string,
    severity: 'error' | 'warning' | 'info' | 'hint',
    lineNum: number,
    lineContent: string,
    suggestion?: string,
  ): AnalysisResult {
    const trimmed = lineContent.trimStart();
    const startChar = lineContent.length - trimmed.length;
    const endChar = Math.max(lineContent.trimEnd().length, startChar + 1);
    return {
      code,
      message,
      severity,
      range: {
        start: { line: lineNum, character: startChar },
        end: { line: lineNum, character: endChar },
      },
      analyzer: 'formation',
      suggestion,
    };
  }
}
