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
export function NLThinkingCrystal() {
  return (
    <Canvas
      camera={{ position: [0, 0, 9], fov: 52 }}
      style={{ width: 96, height: 96, pointerEvents: 'none' }}
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: true }}
    >
      <ambientLight intensity={0.5} color="#d4d8ff" />
      <directionalLight position={[6, 6, 4]} intensity={1.4} color="#c0b8ff" />
      <directionalLight position={[-6, -4, -6]} intensity={0.5} color="#82deff" />
      <pointLight position={[2, 4, 2]} intensity={2.0} color="#8329c8" distance={14} />
      <pointLight position={[-3, -2, 3]} intensity={1.2} color="#2a4bd9" distance={10} />

      <Particles count={40} />
      <CentralCrystal />
    </Canvas>
  );
}
