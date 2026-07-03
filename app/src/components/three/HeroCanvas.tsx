import { useRef, useMemo, useState, useEffect } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import type { RootState } from '@react-three/fiber';
import { Float, Icosahedron, Octahedron, Sphere, Stars, MeshDistortMaterial } from '@react-three/drei';
import * as THREE from 'three';

// Wave 19b (WAVE19_CRYSTAL_IDENTITY_TOKEN_SPEC.md §4.4): the `color` props
// below are Three.js material/light props, not CSS rules — a literal
// 'var(--color-primary)' string won't resolve here the way it does in a
// `style` object. Resolve the brand-reactive CSS custom properties via
// `getComputedStyle` at mount time instead (same pattern as
// NLThinkingCrystal.tsx, deliberately duplicated locally per spec guidance
// rather than a cross-module import — that file lazy-loads independently).
const DEFAULT_PRIMARY_COLOR = '#2a4bd9';
const DEFAULT_TERTIARY_COLOR = '#8329c8';
const DEFAULT_PRIMARY_CONTAINER_COLOR = '#879aff';
const DEFAULT_TERTIARY_CONTAINER_COLOR = '#d299ff';
const DEFAULT_SECONDARY_CONTAINER_COLOR = '#82deff';

export function resolveCssVarColor(varName: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return value || fallback;
}

function useResolvedBrandColors() {
  const [colors, setColors] = useState(() => ({
    primary: DEFAULT_PRIMARY_COLOR,
    tertiary: DEFAULT_TERTIARY_COLOR,
    primaryContainer: DEFAULT_PRIMARY_CONTAINER_COLOR,
    tertiaryContainer: DEFAULT_TERTIARY_CONTAINER_COLOR,
    secondaryContainer: DEFAULT_SECONDARY_CONTAINER_COLOR,
  }));

  useEffect(() => {
    setColors({
      primary: resolveCssVarColor('--color-primary', DEFAULT_PRIMARY_COLOR),
      tertiary: resolveCssVarColor('--color-tertiary', DEFAULT_TERTIARY_COLOR),
      primaryContainer: resolveCssVarColor('--color-primary-container', DEFAULT_PRIMARY_CONTAINER_COLOR),
      tertiaryContainer: resolveCssVarColor('--color-tertiary-container', DEFAULT_TERTIARY_CONTAINER_COLOR),
      secondaryContainer: resolveCssVarColor('--color-secondary-container', DEFAULT_SECONDARY_CONTAINER_COLOR),
    });
  }, []);

  return colors;
}

// Floating particle field
// Exported so NLThinkingCrystal.tsx can reuse it at a smaller `count` for the
// NL builder's thinking-state accent (see BUILDER_SPEC_WAVE2.md §3a) — same
// component, no new geometry, just a different `count` prop.
export function Particles({ count = 350 }) {
  const mesh = useRef<THREE.Points>(null);
  const brandColors = useResolvedBrandColors();
  const positions = useMemo(() => {
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      arr[i * 3]     = (Math.random() - 0.5) * 24;
      arr[i * 3 + 1] = (Math.random() - 0.5) * 16;
      arr[i * 3 + 2] = (Math.random() - 0.5) * 8 - 4;
    }
    return arr;
  }, [count]);

  const colors = useMemo(() => {
    const palette = [
      new THREE.Color(brandColors.primaryContainer),
      new THREE.Color('#57d2f9'),
      new THREE.Color(brandColors.tertiaryContainer),
      new THREE.Color(brandColors.primary),
    ];
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const c = palette[Math.floor(Math.random() * palette.length)];
      arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
    }
    return arr;
  }, [count, brandColors]);

  useFrame((state: RootState) => {
    if (mesh.current) {
      mesh.current.rotation.y = state.clock.elapsedTime * 0.015;
      mesh.current.rotation.x = Math.sin(state.clock.elapsedTime * 0.008) * 0.08;
    }
  });

  return (
    <points ref={mesh}>
      <bufferGeometry>
        <bufferAttribute args={[positions, 3]} attach="attributes-position" count={count} />
        <bufferAttribute args={[colors, 3]} attach="attributes-color" count={count} />
      </bufferGeometry>
      <pointsMaterial size={0.05} vertexColors transparent opacity={0.7} sizeAttenuation />
    </points>
  );
}

// Central crystal with wireframe overlay
// Exported so NLThinkingCrystal.tsx can reuse it verbatim (same geometry/material)
// at thumbnail scale for the NL builder's thinking-state accent (§3a).
export function CentralCrystal() {
  const meshRef = useRef<THREE.Mesh>(null);
  const wireRef = useRef<THREE.Mesh>(null);

  useFrame((state: RootState) => {
    const t = state.clock.elapsedTime;
    if (meshRef.current) {
      meshRef.current.rotation.y = t * 0.12;
      meshRef.current.rotation.x = Math.sin(t * 0.08) * 0.25;
      meshRef.current.rotation.z = Math.cos(t * 0.06) * 0.1;
    }
    if (wireRef.current) {
      wireRef.current.rotation.y = t * 0.12;
      wireRef.current.rotation.x = Math.sin(t * 0.08) * 0.25;
      wireRef.current.rotation.z = Math.cos(t * 0.06) * 0.1;
    }
  });

  return (
    <Float speed={0.8} rotationIntensity={0.1} floatIntensity={0.6}>
      <group position={[0.3, 0.2, 0]}>
        <mesh ref={meshRef}>
          <icosahedronGeometry args={[1.4, 2]} />
          <MeshDistortMaterial
            color="#4338ca"
            roughness={0.0}
            metalness={0.9}
            distort={0.2}
            speed={1.2}
            transparent
            opacity={0.45}
          />
        </mesh>
        <mesh ref={wireRef}>
          <icosahedronGeometry args={[1.42, 2]} />
          <meshBasicMaterial color="#a5b4fc" wireframe transparent opacity={0.12} />
        </mesh>
      </group>
    </Float>
  );
}

// Orbital ring
interface OrbitRingProps {
  radiusX: number;
  radiusY?: number;
  speed: number;
  color: string;
  tiltX?: number;
  tiltZ?: number;
}

function OrbitRing({ radiusX, speed, color, tiltX = 0, tiltZ = 0 }: OrbitRingProps) {
  const groupRef = useRef<THREE.Group>(null);
  useFrame((state: RootState) => {
    if (groupRef.current) {
      groupRef.current.rotation.y = state.clock.elapsedTime * speed;
    }
  });
  return (
    <group ref={groupRef} rotation={[tiltX, 0, tiltZ]}>
      <mesh>
        <torusGeometry args={[radiusX, 0.012, 12, 120]} />
        <meshBasicMaterial color={color} transparent opacity={0.25} />
      </mesh>
    </group>
  );
}

// Small floating gems
interface FloatingGemProps {
  position: [number, number, number];
  color: string;
  rotSpeed?: number;
  type?: 'ico' | 'oct' | 'sphere';
  scale?: number;
}

function FloatingGem({ position, color, rotSpeed = 0.3, type = 'ico', scale = 1 }: FloatingGemProps) {
  const mesh = useRef<THREE.Mesh>(null);
  useFrame((_state: RootState, delta: number) => {
    if (mesh.current) {
      mesh.current.rotation.x += delta * rotSpeed * 0.7;
      mesh.current.rotation.y += delta * rotSpeed;
    }
  });

  const Geo  = type === 'ico' ? Icosahedron : type === 'oct' ? Octahedron : Sphere;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const args: any = type === 'sphere' ? [1, 32, 32] : [1, 1];

  return (
    <Float speed={1.4 + Math.random() * 0.6} rotationIntensity={0.25} floatIntensity={1.0}>
      <mesh ref={mesh} position={position} scale={scale}>
        <Geo args={args} />
        <MeshDistortMaterial
          color={color}
          roughness={0.05}
          metalness={0.6}
          distort={0.3}
          speed={1.8}
          transparent
          opacity={0.7}
        />
      </mesh>
    </Float>
  );
}

export function HeroCanvas() {
  const brandColors = useResolvedBrandColors();
  return (
    <Canvas
      camera={{ position: [0, 0, 9], fov: 52 }}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: true }}
    >
      {/* Lighting */}
      <ambientLight intensity={0.5} color="#d4d8ff" />
      <directionalLight position={[6, 6, 4]} intensity={1.4} color="#c0b8ff" />
      <directionalLight position={[-6, -4, -6]} intensity={0.5} color={brandColors.secondaryContainer} />
      <pointLight position={[2, 4, 2]} intensity={2.0} color={brandColors.tertiary} distance={14} />
      <pointLight position={[-3, -2, 3]} intensity={1.2} color={brandColors.primary} distance={10} />
      <pointLight position={[0, -3, 1]} intensity={0.8} color="#57d2f9" distance={8} />

      {/* Deep starfield */}
      <Stars radius={80} depth={60} count={1800} factor={2.5} saturation={0.3} fade speed={0.4} />

      {/* Colored particle cloud */}
      <Particles count={320} />

      {/* Central hero crystal */}
      <CentralCrystal />

      {/* Orbital rings */}
      <OrbitRing radiusX={2.8} color={brandColors.primaryContainer} speed={0.18} tiltX={1.0} tiltZ={0.3} />
      <OrbitRing radiusX={3.8} color="#57d2f9" speed={-0.11} tiltX={0.5} tiltZ={0.8} />
      <OrbitRing radiusX={2.2} color={brandColors.tertiaryContainer} speed={0.24} tiltX={1.4} tiltZ={-0.4} />

      {/* Background floating gems */}
      <FloatingGem position={[4.0, 1.8, -3]} color="#4338ca" type="ico" rotSpeed={0.18} scale={0.7} />
      <FloatingGem position={[-3.6, -1.4, -2]} color={brandColors.tertiary} type="oct" rotSpeed={0.28} scale={0.6} />
      <FloatingGem position={[2.2, -2.8, -4]} color={brandColors.primary} type="sphere" rotSpeed={0.14} scale={0.5} />
      <FloatingGem position={[-2.0, 3.0, -5]} color="#c984ff" type="ico" rotSpeed={0.22} scale={0.55} />
      <FloatingGem position={[5.0, -0.8, -6]} color={brandColors.primaryContainer} type="oct" rotSpeed={0.16} scale={0.45} />
      <FloatingGem position={[-4.8, 2.0, -7]} color="#57d2f9" type="sphere" rotSpeed={0.20} scale={0.5} />
      <FloatingGem position={[1.5, 3.8, -6]} color="#a5b4fc" type="ico" rotSpeed={0.25} scale={0.35} />
      <FloatingGem position={[-1.8, -3.5, -5]} color="#7c3aed" type="oct" rotSpeed={0.19} scale={0.4} />
    </Canvas>
  );
}
