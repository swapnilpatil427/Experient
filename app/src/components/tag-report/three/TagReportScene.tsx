import { useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Float, Stars } from '@react-three/drei';
import * as THREE from 'three';
import type { TagReportProgress } from '../../../lib/tagReportProgress';
import type { TagReportStage } from '../../../types/tagReport';

// Metric-identity color-coding (never collides with trust/agreement encoding,
// which is line/node thickness + brightness only) — TRACKER.md Part A.
const METRIC_COLOR: Record<string, string> = {
  nps: '#2a4bd9',
  csat: '#8b5cf6',
  ces: '#059669',
};
const GATED_OUT_COLOR = '#94a3b8';

function SurveyNode({
  index,
  total,
  excluded,
  isBackfill,
  stage,
}: {
  index: number;
  total: number;
  excluded: boolean;
  isBackfill: boolean;
  stage: TagReportStage;
}) {
  const ref = useRef<THREE.Mesh>(null);
  const angle = (index / Math.max(total, 1)) * Math.PI * 2;
  const radius = 3.2;
  const x = Math.cos(angle) * radius;
  const y = Math.sin(angle) * radius * 0.4;
  const gating = stage === 'gating' || stage === 'merge' || stage === 'narrative';
  const color = gating && excluded ? GATED_OUT_COLOR : '#879aff';
  const opacity = gating && excluded ? 0.35 : 1;
  const scale = isBackfill ? 0.85 : 1;

  useFrame((state) => {
    if (!ref.current) return;
    const pulse = isBackfill ? Math.sin(state.clock.elapsedTime * 1.5) * 0.05 : Math.sin(state.clock.elapsedTime * 3 + index) * 0.03;
    ref.current.scale.setScalar(scale + pulse);
  });

  return (
    <mesh ref={ref} position={[x, y, 0]}>
      <icosahedronGeometry args={[0.18, 0]} />
      <meshStandardMaterial color={color} transparent opacity={opacity} emissive={color} emissiveIntensity={0.4} />
    </mesh>
  );
}

function ConvergenceZone({ metricKey, offsetX, agreementCount }: { metricKey: string; offsetX: number; agreementCount: number }) {
  const ref = useRef<THREE.Mesh>(null);
  const color = METRIC_COLOR[metricKey] ?? '#64748b';
  const insufficientAgreement = agreementCount < 2;
  const glowColor = insufficientAgreement ? '#d97706' : color;

  useFrame((state) => {
    if (!ref.current) return;
    ref.current.rotation.y = state.clock.elapsedTime * 0.4;
  });

  return (
    <Float speed={1.2} rotationIntensity={0.15} floatIntensity={0.4}>
      <mesh ref={ref} position={[offsetX, -1.2, -0.5]}>
        <octahedronGeometry args={[0.4, 0]} />
        <meshStandardMaterial color={glowColor} emissive={glowColor} emissiveIntensity={0.6} transparent opacity={0.85} />
      </mesh>
    </Float>
  );
}

function Scene({ progress }: { progress: TagReportProgress }) {
  const metricEntries = useMemo(() => Object.values(progress.metricTracks), [progress.metricTracks]);

  return (
    <>
      <ambientLight intensity={0.6} />
      <directionalLight position={[4, 6, 4]} intensity={0.8} />
      <pointLight position={[0, 0, 3]} intensity={0.6} color="#879aff" />
      <Stars radius={60} depth={40} count={600} factor={2} saturation={0.2} fade speed={0.3} />

      {progress.surveys.map((s, i) => (
        <SurveyNode
          key={s.survey_id}
          index={i}
          total={progress.surveys.length}
          excluded={s.excluded}
          isBackfill={s.isBackfill}
          stage={progress.stage}
        />
      ))}

      {(progress.stage === 'merge' || progress.stage === 'narrative') && metricEntries.map((track, i) => (
        <ConvergenceZone
          key={track.metric_key}
          metricKey={track.metric_key}
          offsetX={(i - (metricEntries.length - 1) / 2) * 1.4}
          agreementCount={track.agreementCount}
        />
      ))}
    </>
  );
}

/**
 * The Three.js pipeline-visualization scene (Part A of the UX spec). Always
 * imported via `React.lazy()` — never import this module directly from a page.
 * Reduced-motion gating is the CALLER's responsibility (`PipelineVisualization`),
 * matching `HeroCanvas`'s own convention (it has no internal RM gate either).
 */
export function TagReportScene({ progress }: { progress: TagReportProgress }) {
  return (
    <Canvas
      camera={{ position: [0, 0, 7], fov: 50 }}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: true }}
      aria-hidden="true"
    >
      <Scene progress={progress} />
    </Canvas>
  );
}
