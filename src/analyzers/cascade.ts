import { TextDocument } from 'vscode-languageserver-textdocument';
import { AnalysisResult } from '../types';

/**
 * CASCADE tier marker — declares which layer of the cascade loading order a file occupies.
 *
 * Two marker formats are recognised (both embedded in HTML comments):
 *
 *   <!-- AINLP.fractal[ZOOM] — This is the GENOME layer of the fractal knowledge cascade -->
 *   <!-- CASCADE_TIER: GENOME -->
 *
 * Cascade tiers (outermost → innermost, i.e. loaded first → loaded last):
 *
 *   GENOME     — The compact entry point (e.g. copilot-instructions.md).  Max ~150 lines.
 *   WORKSPACE  — Workspace-scoped .instructions.md files with broad applyTo patterns.
 *   CRYSTAL    — Distilled agent knowledge accumulated across sessions (.crystal.md).
 *   SITUATION  — Current tactical state document (DEV_PATH.md, situation reports).
 *   FABRIC     — Philosophy + deep patterns (AIOS_CONSCIOUSNESS_FABRIC.md).
 *   AGENT      — Individual agent genome files (.agent.md).
 *   SKILL      — Skill definition files (SKILL.md).
 *   PROMPT     — Prompt templates (.prompt.md).
 *
 * Diagnostics emitted:
 *   - cascade-overflow          (WARNING) : file line count exceeds tier limit
 *   - cascade-invalid-order     (ERROR)   : file imports from a higher-priority tier
 *   - cascade-missing-dependency (WARNING): import uses a suspiciously deep relative path
 *   - cascade-circular-reference (ERROR)  : file imports itself
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CascadeTier =
  | 'GENOME'
  | 'WORKSPACE'
  | 'CRYSTAL'
  | 'SITUATION'
  | 'FABRIC'
  | 'AGENT'
  | 'SKILL'
  | 'PROMPT'
  | 'UNKNOWN';

interface CascadeMarker {
  tier: CascadeTier;
  lineNum: number;
  lineContent: string;
}

interface CascadeImport {
  path: string;
  displayText: string;
  lineNum: number;
  lineContent: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Tier ordering by cascade depth: index 0 = outermost (loaded first).
 * A file should NOT import from a tier with a smaller index than itself.
 */
const TIER_ORDER: CascadeTier[] = [
  'GENOME',
  'WORKSPACE',
  'CRYSTAL',
  'SITUATION',
  'FABRIC',
  'AGENT',
  'SKILL',
  'PROMPT',
];

/**
 * Recommended maximum line counts per tier.
 * Exceeding these thresholds suggests content that belongs in a deeper tier.
 */
const TIER_LINE_LIMITS: Partial<Record<CascadeTier, number>> = {
  GENOME: 150,
  WORKSPACE: 250,
  CRYSTAL: 700,
  SITUATION: 400,
  FABRIC: 500,
};

// ---------------------------------------------------------------------------
// Analyzer
// ---------------------------------------------------------------------------

/**
 * Pure-syntax analyzer that validates cascade loading order and content
 * volume for agent instruction / prompt files.  No LLM call required.
 */
export class CascadeAnalyzer {
  // Matches: <!-- AINLP.fractal[ZOOM] — This is the GENOME layer … -->
  private static readonly AINLP_TIER_RE =
    /<!--[^>]*AINLP\.fractal\[ZOOM\][^>]*This is the (\w+) layer/i;

  // Matches: <!-- CASCADE_TIER: GENOME -->
  private static readonly CASCADE_TIER_RE =
    /<!--\s*CASCADE_TIER\s*:\s*(\w+)\s*-->/i;

  // Matches markdown links whose targets are instruction/prompt/skill files.
  // Capturing group 1 = display text, group 2 = file path.
  private static readonly PROMPT_LINK_RE =
    /\[([^\]]+)\]\(([^)]*(?:\.instructions\.md|\.prompt\.md|\.agent\.md|SKILL\.md|copilot-instructions\.md)(?:#[^)]*)?)?\)/gi;

  // File extensions treated as importable cascade files.
  private static readonly PROMPT_EXTENSIONS = [
    '.instructions.md',
    '.prompt.md',
    '.agent.md',
  ];

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Analyse a document for cascade ordering issues.
   *
   * @param doc The document under analysis.
   * @returns   Array of AnalysisResult diagnostics (may be empty).
   */
  analyze(doc: TextDocument): AnalysisResult[] {
    const text = doc.getText();
    const lines = text.split('\n');
    const results: AnalysisResult[] = [];

    // 1. Detect tier marker.
    const marker = this.detectTierMarker(text, lines);

    // 2. Extract all cross-file imports from markdown links.
    const imports = this.extractImports(text, lines);

    // 3. Cascade-overflow: line count vs tier limit.
    if (marker !== null && marker.tier !== 'UNKNOWN') {
      const limit = TIER_LINE_LIMITS[marker.tier];
      if (limit !== undefined && lines.length > limit) {
        results.push(this.makeResult(
          'cascade-overflow',
          `${marker.tier} tier file has ${lines.length} lines — exceeds the recommended ` +
          `limit of ${limit}. Consider moving detailed content to a deeper tier ` +
          `(Crystal, Situation, or Fabric).`,
          'warning',
          marker.lineNum,
          marker.lineContent,
          `Extract operational details into a lower-tier file and reference it from here. ` +
          `${marker.tier} tier files should be compact entry points that direct deeper loading.`,
        ));
      }
    }

    // 4. Self-referential imports → cascade-circular-reference.
    const docFilename = this.filenameFromUri(doc.uri);
    for (const imp of imports) {
      const importedFilename = this.filenameFromPath(imp.path);
      if (importedFilename !== '' && importedFilename === docFilename) {
        results.push(this.makeResult(
          'cascade-circular-reference',
          `Circular reference: this file imports itself via "[${imp.displayText}](${imp.path})". ` +
          `A cascade file cannot load itself.`,
          'error',
          imp.lineNum,
          imp.lineContent,
          'Remove the self-referential link.',
        ));
      }
    }

    // 5. Import ordering: a file should not import from a higher-priority tier.
    if (marker !== null && marker.tier !== 'UNKNOWN') {
      const myTierIndex = TIER_ORDER.indexOf(marker.tier);
      if (myTierIndex >= 0) {
        for (const imp of imports) {
          const importedTier = this.inferTierFromPath(imp.path);
          const importedTierIndex = TIER_ORDER.indexOf(importedTier);
          if (importedTierIndex >= 0 && importedTierIndex < myTierIndex) {
            results.push(this.makeResult(
              'cascade-invalid-order',
              `${marker.tier} tier file imports from the higher-priority ${importedTier} tier ` +
              `("${imp.path}"). Lower-tier files should not depend on higher-tier files — ` +
              `the cascade flows outward-to-inward (GENOME → CRYSTAL → PROMPT), not inward-to-outward.`,
              'error',
              imp.lineNum,
              imp.lineContent,
              `Move the shared content to a ${marker.tier}-level file, or hoist the reference ` +
              `to a file that is at or above the ${importedTier} tier.`,
            ));
          }
        }
      }
    }

    // 6. Suspiciously deep relative paths → cascade-missing-dependency.
    for (const imp of imports) {
      const upLevels = (imp.path.match(/\.\.\//g) ?? []).length;
      if (upLevels > 3) {
        results.push(this.makeResult(
          'cascade-missing-dependency',
          `Import "${imp.path}" navigates ${upLevels} directory levels up. ` +
          `Deeply relative paths are brittle and may silently break when the file is moved.`,
          'warning',
          imp.lineNum,
          imp.lineContent,
          'Use a path anchored closer to the workspace root, or move the referenced file ' +
          'to a location that requires fewer traversals.',
        ));
      }
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns the first CASCADE_TIER marker found in the document, or null if
   * neither the AINLP nor the explicit CASCADE_TIER comment is present.
   */
  private detectTierMarker(text: string, lines: string[]): CascadeMarker | null {
    // Prefer AINLP.fractal[ZOOM] markers (matches AIOS genome convention).
    const ainlpMatch = CascadeAnalyzer.AINLP_TIER_RE.exec(text);
    if (ainlpMatch) {
      const tier = this.normalizeTier(ainlpMatch[1]);
      const lineNum = text.slice(0, ainlpMatch.index).split('\n').length - 1;
      return { tier, lineNum, lineContent: lines[lineNum] ?? '' };
    }

    // Fall back to explicit CASCADE_TIER comment.
    const cascadeMatch = CascadeAnalyzer.CASCADE_TIER_RE.exec(text);
    if (cascadeMatch) {
      const tier = this.normalizeTier(cascadeMatch[1]);
      const lineNum = text.slice(0, cascadeMatch.index).split('\n').length - 1;
      return { tier, lineNum, lineContent: lines[lineNum] ?? '' };
    }

    return null;
  }

  /**
   * Extracts all markdown links whose targets are cascade-participating files
   * (.instructions.md, .prompt.md, .agent.md, SKILL.md, copilot-instructions.md).
   */
  private extractImports(text: string, lines: string[]): CascadeImport[] {
    const imports: CascadeImport[] = [];
    const re = new RegExp(CascadeAnalyzer.PROMPT_LINK_RE.source, 'gi');
    let match: RegExpExecArray | null;

    while ((match = re.exec(text)) !== null) {
      const displayText = match[1] ?? '';
      const rawPath = match[2];

      // Skip anchored-only links or empty paths.
      if (!rawPath || rawPath.startsWith('#')) continue;

      // Strip fragment identifier (e.g. file.md#section).
      const path = rawPath.split('#')[0].trim();
      if (!path) continue;

      const lineNum = text.slice(0, match.index).split('\n').length - 1;
      imports.push({
        path,
        displayText,
        lineNum,
        lineContent: lines[lineNum] ?? '',
      });
    }

    return imports;
  }

  /**
   * Heuristically infers the cascade tier of an imported file from its name / path.
   * Returns 'UNKNOWN' when no pattern matches.
   */
  private inferTierFromPath(path: string): CascadeTier {
    const lower = path.toLowerCase();
    if (lower.includes('copilot-instructions')) return 'GENOME';
    if (lower.includes('.crystal.')) return 'CRYSTAL';
    if (lower.includes('dev_path') || lower.includes('situation')) return 'SITUATION';
    if (lower.includes('fabric')) return 'FABRIC';
    if (lower.endsWith('skill.md')) return 'SKILL';
    if (lower.endsWith('.agent.md')) return 'AGENT';
    if (lower.endsWith('.prompt.md')) return 'PROMPT';
    if (lower.endsWith('.instructions.md')) return 'WORKSPACE';
    return 'UNKNOWN';
  }

  /** Maps a raw tier string to a canonical CascadeTier, defaulting to UNKNOWN. */
  private normalizeTier(raw: string): CascadeTier {
    const upper = raw.toUpperCase();
    if ((TIER_ORDER as string[]).includes(upper)) return upper as CascadeTier;
    return 'UNKNOWN';
  }

  /** Extracts the filename component from a URI or full path. */
  private filenameFromUri(uri: string): string {
    return uri.split('/').pop() ?? '';
  }

  /** Extracts the filename component from a relative or absolute file path. */
  private filenameFromPath(path: string): string {
    return path.split('/').pop()?.split('\\').pop() ?? '';
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
      analyzer: 'cascade',
      suggestion,
    };
  }
}
