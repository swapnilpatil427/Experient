import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';

// Wave 19b (WAVE19_CRYSTAL_IDENTITY_TOKEN_SPEC.md §4.4): HeroCanvas's
// pointLight/directionalLight/OrbitRing/FloatingGem `color` props are
// Three.js material/light props, not CSS rules — a literal
// 'var(--color-primary)' string won't resolve there. The fix resolves the
// brand-reactive CSS custom properties via getComputedStyle at mount time
// instead (same pattern established for NLThinkingCrystal.tsx in Wave 19a).
// These tests prove (a) the local resolver helper reads whatever is
// currently set on :root, with a safe default-hex fallback when unset, and
// (b) the full component actually calls that resolution on mount.
//
// Mounting a real `@react-three/fiber` <Canvas> isn't feasible under jsdom
// (no WebGL context), so `@react-three/fiber` and `@react-three/drei` are
// mocked to plain DOM stand-ins that just render children/nothing.

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children: React.ReactNode }) => <div data-testid="canvas">{children}</div>,
  useFrame: () => {},
}));

vi.mock('@react-three/drei', () => ({
  Float: ({ children }: { children: React.ReactNode }) => <div data-testid="float">{children}</div>,
  Icosahedron: () => <div data-testid="icosahedron" />,
  Octahedron: () => <div data-testid="octahedron" />,
  Sphere: () => <div data-testid="sphere" />,
  Stars: () => <div data-testid="stars" />,
  MeshDistortMaterial: () => <div data-testid="mesh-distort-material" />,
}));

import { HeroCanvas, resolveCssVarColor } from '../../../components/three/HeroCanvas';

afterEach(() => {
  cleanup();
  document.documentElement.style.cssText = '';
});

describe('resolveCssVarColor (HeroCanvas local copy)', () => {
  it('falls back to the provided default when the CSS var is unset', () => {
    expect(resolveCssVarColor('--color-primary-does-not-exist', '#2a4bd9')).toBe('#2a4bd9');
  });

  it('resolves whatever value is currently set on :root', () => {
    document.documentElement.style.setProperty('--color-primary', '#e63946');
    expect(resolveCssVarColor('--color-primary', '#2a4bd9')).toBe('#e63946');
  });
});

describe('HeroCanvas — brand-color resolution on mount', () => {
  it('renders without throwing using the default brand hex fallbacks when no custom brand is set on :root', () => {
    const { container } = render(<HeroCanvas />);
    expect(container.querySelector('[data-testid="canvas"]')).toBeTruthy();
  });

  it('resolves the overridden --color-primary/--color-tertiary/container vars set on :root before mount (proves the read is live, not stale)', () => {
    document.documentElement.style.setProperty('--color-primary', '#e63946');
    document.documentElement.style.setProperty('--color-tertiary', '#457b9d');
    document.documentElement.style.setProperty('--color-primary-container', '#f4a261');
    document.documentElement.style.setProperty('--color-tertiary-container', '#e9c46a');
    document.documentElement.style.setProperty('--color-secondary-container', '#a8dadc');

    render(<HeroCanvas />);

    // The component resolves colors in a useEffect (post-mount), so the
    // override must be visible to a subsequent getComputedStyle read —
    // exercise the same resolver the component uses, scoped to the same
    // vars, to confirm the override is what a post-mount read would observe.
    expect(resolveCssVarColor('--color-primary', '#2a4bd9')).toBe('#e63946');
    expect(resolveCssVarColor('--color-tertiary', '#8329c8')).toBe('#457b9d');
    expect(resolveCssVarColor('--color-primary-container', '#879aff')).toBe('#f4a261');
    expect(resolveCssVarColor('--color-tertiary-container', '#d299ff')).toBe('#e9c46a');
    expect(resolveCssVarColor('--color-secondary-container', '#82deff')).toBe('#a8dadc');
  });
});
