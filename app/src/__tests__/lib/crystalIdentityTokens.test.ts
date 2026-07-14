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
];

// Crystal brand hex + their rgba-decomposed forms (primary = 42,75,217; tertiary = 131,41,200).
const LITERAL_HEX_PATTERN = /#2a4bd9|#8329c8|#173dcd|#879aff|#d299ff|#00647c|#82deff/i;
const LITERAL_RGBA_PATTERN = /rgba\(\s*42,\s*75,\s*217|rgba\(\s*131,\s*41,\s*200/i;

// CrystalPanel.tsx's LAYER_COLORS block (insight-layer taxonomy — descriptive/
// diagnostic/predictive/prescriptive, a fixed 4-color legend) is explicitly
// excluded from Wave 19 tokenization (spec §3c) — it's a data-viz categorical
// palette, not brand chrome, and must keep its hex values stable regardless of
// org brand. Skip lines within that block when scanning CrystalPanel.tsx.
//
// Line range updated 2026-07-03 (tag-report/automation-hub merge): merging in
// Tag Report's own additions earlier in the file (the tag-focus scope chip,
// action-proposal handlers, etc.) shifted LAYER_COLORS from its original
// [1668, 1673] down to its current location — a hardcoded line range is
// inherently this fragile across any merge that adds content above it; kept
// as a range (not content-matched) to stay consistent with how this test was
// originally authored, just re-pointed at the block's real current position.
const EXCLUDED_LINE_RANGES: Record<string, Array<[number, number]>> = {
  'src/components/CrystalPanel.tsx': [[1733, 1738]],
};

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function readLines(relativePath: string): string[] {
  const absPath = resolve(REPO_ROOT, 'app', relativePath);
  return readFileSync(absPath, 'utf-8').split('\n');
}

describe('Crystal-identity files contain no literal brand hex (Wave 19a)', () => {
  for (const file of CRYSTAL_IDENTITY_FILES) {
    it(`${file} has zero literal Crystal-brand hex/rgba hits outside excluded ranges`, () => {
      const lines = readLines(file);
      const excluded = EXCLUDED_LINE_RANGES[file] ?? [];
      const offenders: string[] = [];

      lines.forEach((line, idx) => {
        const lineNo = idx + 1;
        const isExcluded = excluded.some(([start, end]) => lineNo >= start && lineNo <= end);
        if (isExcluded) return;
        if (LITERAL_HEX_PATTERN.test(line) || LITERAL_RGBA_PATTERN.test(line)) {
          offenders.push(`  L${lineNo}: ${line.trim()}`);
        }
      });

      expect(offenders, `Found literal Crystal-brand hex in ${file}:\n${offenders.join('\n')}`).toHaveLength(0);
    });
  }
});
