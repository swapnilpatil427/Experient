import { useEffect, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { CentralCrystal, Particles } from './HeroCanvas';

// Small (~96px) ambient 3D accent for the NL builder's thinking state only
// (BUILDER_SPEC_WAVE2.md §3a). Reuses HeroCanvas's CentralCrystal + a
// reduced-count Particles field directly — no new geometry. No Stars,
// OrbitRing, FloatingGem, or OrbitControls: those exist to fill a full
// viewport and would be wasted at thumbnail scale. Purely decorative
// (`pointerEvents: 'none'`), lazy-loaded by the caller exactly like
// HeroCanvas, and expected to be hard-unmounted (not faded) the instant the
// parse request resolves — this component has no opinion on that lifecycle,
// it's just the visual; the caller (WorkflowNLBuilderPage) controls mounting.
//
// Wave 19a (WAVE19_CRYSTAL_IDENTITY_TOKEN_SPEC.md §4.4): Three.js light `color`
// props are JS material props, not CSS rules — `var(--color-primary)` as a
// literal string won't resolve here the way it does in a `style` object. We
// read the brand-reactive CSS custom properties via `getComputedStyle` at
// mount time instead, so an org's custom brand color still reaches the
// thinking crystal, it's just resolved in JS rather than left as a live CSS
// var reference.
const DEFAULT_PRIMARY_COLOR = '#2a4bd9';
const DEFAULT_TERTIARY_COLOR = '#8329c8';
const DEFAULT_SECONDARY_CONTAINER_COLOR = '#82deff';

// Exported for direct unit testing (mounting a real `@react-three/fiber`
// Canvas under jsdom isn't feasible — no WebGL context — so the resolution
// logic itself is the testable seam; see
// src/__tests__/components/three/NLThinkingCrystal.test.tsx).
export function resolveCssVarColor(varName: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return value || fallback;
}

export function NLThinkingCrystal() {
  const [colors, setColors] = useState(() => ({
    primary: DEFAULT_PRIMARY_COLOR,
    tertiary: DEFAULT_TERTIARY_COLOR,
    secondaryContainer: DEFAULT_SECONDARY_CONTAINER_COLOR,
  }));

  useEffect(() => {
    setColors({
      primary: resolveCssVarColor('--color-primary', DEFAULT_PRIMARY_COLOR),
      tertiary: resolveCssVarColor('--color-tertiary', DEFAULT_TERTIARY_COLOR),
      secondaryContainer: resolveCssVarColor('--color-secondary-container', DEFAULT_SECONDARY_CONTAINER_COLOR),
    });
  }, []);

  return (
    <Canvas
      camera={{ position: [0, 0, 9], fov: 52 }}
      style={{ width: 96, height: 96, pointerEvents: 'none' }}
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: true }}
    >
      <ambientLight intensity={0.5} color="#d4d8ff" />
      <directionalLight position={[6, 6, 4]} intensity={1.4} color="#c0b8ff" />
      <directionalLight position={[-6, -4, -6]} intensity={0.5} color={colors.secondaryContainer} />
      <pointLight position={[2, 4, 2]} intensity={2.0} color={colors.tertiary} distance={14} />
      <pointLight position={[-3, -2, 3]} intensity={1.2} color={colors.primary} distance={10} />

      <Particles count={40} />
      <CentralCrystal />
    </Canvas>
  );
}
