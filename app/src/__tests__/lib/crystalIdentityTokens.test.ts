import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Wave 19a (docs/automation-hub/WAVE19_CRYSTAL_IDENTITY_TOKEN_SPEC.md §5.1):
// static regression guard against literal Crystal-brand hex reappearing in the
// Crystal-identity surface. Scoped narrowly to the files in the spec's §3a
// inventory — NOT the whole repo, since category (c) files (insight-layer
// taxonomy, question/survey-type enums, priority/status enums) are *supposed*
// to keep these hex values; tokenizing them would be a bug, not a fix.
//
// NLThinkingCrystal.tsx is intentionally excluded from the "zero literal hex"
// assertion: it legitimately keeps `#2a4bd9`/`#8329c8`/`#82deff` as named
// `DEFAULT_*_COLOR` fallback constants for its getComputedStyle-based
// resolution (Three.js light `color` props can't consume a CSS var string
// directly — see spec §4.4). Its own dedicated test
// (three/NLThinkingCrystal.test.tsx) verifies the JS-resolution path instead.
const CRYSTAL_IDENTITY_FILES = [
  'src/components/CrystalPanel.tsx',
  'src/components/workflow-builder/AskCrystalFab.tsx',
  'src/components/dashboard/widgets/CrystalNarrativeWidget.tsx',
  // Crystal-branded surface owning the survey-builder copilot; same brand rules apply.
  'src/components/ExperientCopilot.tsx',
];

// Crystal brand hex + their rgba-decomposed forms (primary = 42,75,217; tertiary = 131,41,200).
const LITERAL_HEX_PATTERN = /#2a4bd9|#8329c8|#173dcd|#879aff|#d299ff|#00647c|#82deff/i;
const LITERAL_RGBA_PATTERN = /rgba\(\s*42,\s*75,\s*217|rgba\(\s*131,\s*41,\s*200/i;

// CrystalPanel.tsx's LAYER_COLORS block (insight-layer taxonomy — descriptive/
// diagnostic/predictive/prescriptive, a fixed 4-color legend) is explicitly
// excluded from Wave 19 tokenization (spec §3c) — it's a data-viz categorical
// palette, not brand chrome, and must keep its hex values stable regardless of
// org brand.
//
// Matched by declaration name, not line range. A positional window both breaks on
// any reflow above the block (a hardcoded range silently stopped covering the
// real block after any earlier edit shifted line numbers) and silently forgives
// real offenders that land inside it.
const EXCLUDED_BLOCKS: Record<string, string[]> = {
  'src/components/CrystalPanel.tsx': ['LAYER_COLORS'],
};

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function readLines(relativePath: string): string[] {
  const absPath = resolve(REPO_ROOT, 'app', relativePath);
  return readFileSync(absPath, 'utf-8').split('\n');
}

/**
 * Resolve the 1-indexed line numbers occupied by each named object-literal
 * declaration, by brace-counting from the declaration to its closing brace.
 *
 * Exported for direct unit testing (see the "exclusion resolver" describe block)
 * so the reflow-resilience property is proven, not assumed.
 */
export function resolveExcludedLines(lines: string[], blockNames: string[]): Set<number> {
  const excluded = new Set<number>();

  for (const name of blockNames) {
    const startIdx = lines.findIndex((l) => new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`).test(l));
    if (startIdx === -1) continue;

    let depth = 0;
    let seenOpen = false;
    for (let i = startIdx; i < lines.length; i++) {
      excluded.add(i + 1);
      for (const ch of lines[i]) {
        if (ch === '{') { depth++; seenOpen = true; }
        else if (ch === '}') depth--;
      }
      if (seenOpen && depth <= 0) break;
    }
  }

  return excluded;
}

describe('Crystal-identity files contain no literal brand hex (Wave 19a)', () => {
  for (const file of CRYSTAL_IDENTITY_FILES) {
    it(`${file} has zero literal Crystal-brand hex/rgba hits outside excluded blocks`, () => {
      const lines = readLines(file);
      const excluded = resolveExcludedLines(lines, EXCLUDED_BLOCKS[file] ?? []);
      const offenders: string[] = [];

      lines.forEach((line, idx) => {
        const lineNo = idx + 1;
        if (excluded.has(lineNo)) return;
        if (LITERAL_HEX_PATTERN.test(line) || LITERAL_RGBA_PATTERN.test(line)) {
          offenders.push(`  L${lineNo}: ${line.trim()}`);
        }
      });

      expect(offenders, `Found literal Crystal-brand hex in ${file}:\n${offenders.join('\n')}`).toHaveLength(0);
    });
  }

  // Guard the guard: if a named excluded block disappears (renamed, moved to
  // another file, deleted), the exclusion silently becomes a no-op and this test
  // would keep passing while covering less. Assert the block is still there.
  for (const [file, names] of Object.entries(EXCLUDED_BLOCKS)) {
    it(`${file} still declares its excluded blocks (${names.join(', ')})`, () => {
      const lines = readLines(file);
      for (const name of names) {
        const found = lines.some((l) => new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`).test(l));
        expect(
          found,
          `EXCLUDED_BLOCKS lists "${name}" for ${file} but no such declaration exists. ` +
            `If it moved, update EXCLUDED_BLOCKS — do not leave a dead exclusion.`,
        ).toBe(true);
      }
    });
  }
});

describe('exclusion resolver is reflow-resilient (regression for the old hardcoded line range)', () => {
  const block = [
    "const LAYER_COLORS: Record<string, string> = {",
    "  prescriptive: '#059669',",
    "  diagnostic:   '#7c3aed',",
    "  predictive:   '#d97706',",
    "  descriptive:  '#2a4bd9',",  // the only brand-hex hit
    '};',
  ];

  it('finds the block at its real position regardless of preceding content', () => {
    for (const padding of [0, 1, 2, 50]) {
      const lines = [...Array(padding).fill('// filler'), ...block];
      const excluded = resolveExcludedLines(lines, ['LAYER_COLORS']);
      // All six block lines excluded, wherever the block starts.
      for (let i = 1; i <= block.length; i++) {
        expect(excluded.has(padding + i), `padding=${padding} line=${padding + i}`).toBe(true);
      }
      // The brand hex line specifically — this is what the old hardcoded range lost on reflow.
      expect(excluded.has(padding + 5)).toBe(true);
    }
  });

  it('does not over-exclude past the closing brace', () => {
    const lines = [...block, "const OFFENDER = '#2a4bd9';"];
    const excluded = resolveExcludedLines(lines, ['LAYER_COLORS']);
    expect(excluded.has(block.length + 1)).toBe(false);
  });

  it('returns an empty set when the named block is absent', () => {
    expect(resolveExcludedLines(['// nothing here'], ['LAYER_COLORS']).size).toBe(0);
  });
});
