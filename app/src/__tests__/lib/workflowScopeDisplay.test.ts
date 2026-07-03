import { describe, it, expect } from 'vitest';
import { scopeChipKey, scopeRailColorVar } from '../../lib/workflowScopeDisplay';

// Wave 19c (WAVE19_CRYSTAL_IDENTITY_TOKEN_SPEC.md §0.2): scopeRailColorVar('tag')
// previously returned 'var(--color-accent)', which resolves to an unrelated
// shadcn-bridge neutral gray (#dfe3e6 / #2c2f31, index.css's @theme block) — not
// the brand purple. The correct semantic alias for brand-accent/Crystal-purple
// is '--color-tertiary'. This regression test locks in the fix.
describe('scopeRailColorVar', () => {
  it('returns --color-primary for survey scope', () => {
    expect(scopeRailColorVar('survey')).toBe('var(--color-primary)');
  });

  it('returns --color-tertiary for tag scope (not --color-accent)', () => {
    expect(scopeRailColorVar('tag')).toBe('var(--color-tertiary)');
    expect(scopeRailColorVar('tag')).not.toBe('var(--color-accent)');
  });

  it('returns --color-outline for org scope and undefined', () => {
    expect(scopeRailColorVar('org')).toBe('var(--color-outline)');
    expect(scopeRailColorVar(undefined)).toBe('var(--color-outline)');
  });
});

describe('scopeChipKey', () => {
  it('defaults to org when scope_type is missing', () => {
    expect(scopeChipKey({ scope_type: undefined })).toBe('org');
  });

  it('passes through an explicit scope_type', () => {
    expect(scopeChipKey({ scope_type: 'tag' })).toBe('tag');
    expect(scopeChipKey({ scope_type: 'survey' })).toBe('survey');
  });
});
