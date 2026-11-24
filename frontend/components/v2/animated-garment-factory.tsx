"use client";

import { ContactShadows, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { useTheme } from "./theme-provider";
import { FactoryErrorBoundary } from "./factory-error-boundary";
import { FactorySky } from "./factory-sky";

function Smoke({ dark, animate }: { dark: boolean; animate: boolean }) {
  const puffs = useRef<Array<THREE.Mesh | null>>([]);
  const seeds = useMemo(
    () => Array.from({ length: 10 }, (_, index) => ({ phase: index / 10, drift: 0.72 + (index % 4) * 0.12 })),
    [],
  );

  useFrame((state) => {
    const elapsed = animate ? state.clock.elapsedTime : 0;
    puffs.current.forEach((mesh, index) => {
      if (!mesh) return;
      const seed = seeds[index];
      const progress = (elapsed * 0.095 + seed.phase) % 1;
      mesh.position.set(
        3.38 + Math.sin(progress * 5.2 + index * 0.64) * 0.2 * seed.drift,
        5.52 + progress * 3.7,
        -1.28 + Math.cos(progress * 3.6 + index) * 0.12,
      );
      const scale = 0.13 + progress * 0.62;
      mesh.scale.set(scale * 1.15, scale, scale);
      const material = mesh.material as THREE.MeshBasicMaterial;
      material.opacity = Math.sin(progress * Math.PI) * (dark ? 0.16 : 0.2);
    });
  });

  return (
    <group aria-label="Decorative chimney smoke">
      {seeds.map((seed, index) => (
        <mesh key={seed.phase} ref={(mesh) => { puffs.current[index] = mesh; }}>
          <sphereGeometry args={[0.8, 14, 12]} />
          <meshBasicMaterial color={dark ? "#b9c2ca" : "#d9dde0"} transparent opacity={0} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
}

function IndustrialWindow({ position, scale = [1, 1, 1] }: { position: [number, number, number]; scale?: [number, number, number] }) {
  return (
    <group position={position} scale={scale}>
      <mesh castShadow>
        <boxGeometry args={[0.86, 0.72, 0.1]} />
        <meshStandardMaterial color="#101820" metalness={0.72} roughness={0.28} />
      </mesh>
      <mesh position={[0, 0, 0.061]}>
        <boxGeometry args={[0.7, 0.57, 0.025]} />
        <meshStandardMaterial color="#87c7ce" emissive="#4fabb5" emissiveIntensity={0.7} metalness={0.25} roughness={0.18} />
      </mesh>
      <mesh position={[0, 0, 0.08]}>
        <boxGeometry args={[0.032, 0.58, 0.018]} />
        <meshStandardMaterial color="#26343d" metalness={0.7} />
      </mesh>
    </group>
  );
}

function LoadingBay({ x, label }: { x: number; label: number }) {
  return (
    <group position={[x, 0.82, 3.03]}>
      <mesh castShadow>
        <boxGeometry args={[1.8, 1.55, 0.18]} />
        <meshStandardMaterial color="#18232c" metalness={0.42} roughness={0.52} />
      </mesh>
      {[-0.52, -0.17, 0.18, 0.53].map((offset) => (
        <mesh key={offset} position={[0, offset, 0.11]}>
          <boxGeometry args={[1.58, 0.055, 0.025]} />
          <meshStandardMaterial color="#5d6a71" metalness={0.74} roughness={0.33} />
        </mesh>
      ))}
      <mesh position={[0, -0.93, 0.1]} receiveShadow>
        <boxGeometry args={[2.1, 0.24, 0.85]} />
        <meshStandardMaterial color="#323c42" roughness={0.8} />
      </mesh>
      <mesh position={[0.65, 0.92, 0.13]}>
        <boxGeometry args={[0.28, 0.28, 0.035]} />
        <meshStandardMaterial color={label === 1 ? "#f3a84a" : "#6ac4ca"} emissive={label === 1 ? "#d47b1e" : "#31939d"} emissiveIntensity={0.72} />
      </mesh>
    </group>
  );
}

function RoofVent({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 4.38, z]}>
      <mesh castShadow>
        <cylinderGeometry args={[0.34, 0.5, 0.48, 18]} />
        <meshStandardMaterial color="#52616a" metalness={0.66} roughness={0.34} />
      </mesh>
      <mesh position={[0, 0.28, 0]} castShadow>
        <cylinderGeometry args={[0.48, 0.3, 0.15, 18]} />
        <meshStandardMaterial color="#73828a" metalness={0.7} roughness={0.3} />
      </mesh>
    </group>
  );
}

function LightMast({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh castShadow position={[0, 1.5, 0]}>
        <cylinderGeometry args={[0.055, 0.075, 3, 10]} />
        <meshStandardMaterial color="#44515a" metalness={0.8} roughness={0.25} />
      </mesh>
      <mesh position={[0, 3, 0.12]} rotation={[-0.22, 0, 0]}>
        <boxGeometry args={[0.42, 0.16, 0.3]} />
        <meshStandardMaterial color="#d9e8e7" emissive="#b7e7e5" emissiveIntensity={1.5} />
      </mesh>
      <pointLight position={[0, 2.85, 0.6]} color="#bde9e7" intensity={5} distance={5.5} />
    </group>
  );
}

function IndustrialComplex({ dark, animate }: { dark: boolean; animate: boolean }) {
  const complex = useRef<THREE.Group>(null);
  const beacon = useRef<THREE.PointLight>(null);

  useFrame((state) => {
    if (!animate) return;
    if (complex.current) complex.current.position.y = Math.sin(state.clock.elapsedTime * 0.24) * 0.012 - 0.48;
    if (beacon.current) beacon.current.intensity = 3.5 + (Math.sin(state.clock.elapsedTime * 2.3) + 1) * 2.3;
  });

  return (
    <group ref={complex} position={[0, -0.48, 0]} rotation={[0, -0.1, 0]}>
      <mesh castShadow receiveShadow position={[0, 1.9, 0]}>
        <boxGeometry args={[11.8, 3.9, 6]} />
        <meshStandardMaterial color={dark ? "#27333b" : "#778086"} roughness={0.66} metalness={0.16} />
      </mesh>
      <mesh castShadow position={[0, 4.03, 0]}>
        <boxGeometry args={[12.15, 0.32, 6.32]} />
        <meshStandardMaterial color={dark ? "#111b22" : "#303b42"} roughness={0.48} metalness={0.55} />
      </mesh>

      {[-3.8, 0, 3.8].map((x) => (
        <group key={x} position={[x, 4.34, 0]}>
          <mesh castShadow rotation={[0, 0, -0.16]} position={[-0.92, 0.18, 0]}>
            <boxGeometry args={[1.95, 0.18, 5.65]} />
            <meshStandardMaterial color="#394750" metalness={0.52} roughness={0.43} />
          </mesh>
          <mesh castShadow rotation={[0, 0, 0.16]} position={[0.92, 0.18, 0]}>
            <boxGeometry args={[1.95, 0.18, 5.65]} />
            <meshStandardMaterial color="#46545c" metalness={0.52} roughness={0.4} />
          </mesh>
          <mesh position={[0, 0.58, 0]}>
            <boxGeometry args={[0.34, 0.36, 5.5]} />
            <meshStandardMaterial color="#74aeb4" emissive="#4a98a1" emissiveIntensity={0.34} roughness={0.2} />
          </mesh>
        </group>
      ))}

      {[-4.75, -3.55, -2.35, -1.15, 0.05, 1.25, 2.45, 3.65, 4.85].flatMap((x) =>
        [1.55, 2.65].map((y) => <IndustrialWindow key={`${x}-${y}`} position={[x, y, 3.04]} />),
      )}

      <group position={[-4.65, 1.15, 3.08]}>
        <mesh castShadow>
          <boxGeometry args={[1.7, 2.3, 0.24]} />
          <meshStandardMaterial color="#101a20" metalness={0.36} roughness={0.48} />
        </mesh>
        <mesh position={[0, 0.2, 0.15]}>
          <boxGeometry args={[0.68, 1.28, 0.04]} />
          <meshStandardMaterial color="#4c9aa3" emissive="#398995" emissiveIntensity={0.48} roughness={0.2} />
        </mesh>
        <mesh position={[0, 1.48, 0.2]}>
          <boxGeometry args={[2.6, 0.48, 0.14]} />
          <meshStandardMaterial color="#18242b" metalness={0.52} roughness={0.38} />
        </mesh>
      </group>
      <LoadingBay x={2.55} label={1} />
      <LoadingBay x={4.75} label={2} />

      <mesh castShadow receiveShadow position={[-7.3, 1.16, -0.45]}>
        <boxGeometry args={[2.6, 2.45, 4.5]} />
        <meshStandardMaterial color={dark ? "#202b33" : "#657078"} roughness={0.7} metalness={0.12} />
      </mesh>
      <mesh castShadow position={[-7.3, 2.47, -0.45]}>
        <boxGeometry args={[2.82, 0.24, 4.72]} />
        <meshStandardMaterial color="#182229" metalness={0.58} roughness={0.4} />
      </mesh>
      {[-1.55, -0.35, 0.85].map((z) => <IndustrialWindow key={z} position={[-5.97, 1.35, z]} scale={[0.8, 0.82, 1]} />)}

      <mesh castShadow position={[3.38, 4.82, -1.28]}>
        <cylinderGeometry args={[0.36, 0.49, 2.15, 20]} />
        <meshStandardMaterial color="#4a5961" roughness={0.38} metalness={0.72} />
      </mesh>
      <mesh position={[3.38, 5.92, -1.28]}>
        <torusGeometry args={[0.38, 0.07, 10, 24]} />
        <meshStandardMaterial color="#86949a" metalness={0.78} roughness={0.28} />
      </mesh>
      <Smoke dark={dark} animate={animate} />
      <RoofVent x={-3.15} z={-1.5} />
      <RoofVent x={-1.7} z={-1.5} />
      <RoofVent x={0.1} z={-1.5} />

      <group position={[-0.8, 4.45, 1.1]} rotation={[-0.18, 0, 0]}>
        {[-1.7, 0, 1.7].map((x) => (
          <mesh key={x} position={[x, 0, 0]} castShadow>
            <boxGeometry args={[1.4, 0.08, 1.85]} />
            <meshStandardMaterial color="#173a4a" metalness={0.62} roughness={0.18} />
          </mesh>
        ))}
      </group>

      <mesh position={[-5.6, 3.1, 3.2]}>
        <boxGeometry args={[0.24, 0.24, 0.24]} />
        <meshStandardMaterial color="#ff9c43" emissive="#ff6a1a" emissiveIntensity={1.4} />
      </mesh>
      <pointLight ref={beacon} position={[-5.6, 3.15, 3.55]} color="#ff7a2d" intensity={5} distance={4.5} />

      <LightMast position={[-7.5, 0, 5.25]} />
      <LightMast position={[0, 0, 5.7]} />
      <LightMast position={[7.4, 0, 4.8]} />

      <group position={[7.2, 0.55, 1.35]}>
        <mesh castShadow>
          <boxGeometry args={[2.4, 1.05, 1.45]} />
          <meshStandardMaterial color="#293740" roughness={0.52} metalness={0.38} />
        </mesh>
        <mesh position={[0, 0.05, 0.74]}>
          <boxGeometry args={[1.82, 0.38, 0.03]} />
          <meshStandardMaterial color="#5faab0" emissive="#3b848c" emissiveIntensity={0.34} />
        </mesh>
      </group>

      {[-7.6, -5.7, -3.8, -1.9, 0, 1.9, 3.8, 5.7, 7.6].map((x) => (
        <mesh key={x} position={[x, 0.55, 7.05]} castShadow>
          <cylinderGeometry args={[0.045, 0.055, 1.1, 8]} />
          <meshStandardMaterial color="#53616a" metalness={0.72} roughness={0.35} />
        </mesh>
      ))}
      <mesh position={[0, 0.96, 7.05]}>
        <boxGeometry args={[15.2, 0.035, 0.035]} />
        <meshStandardMaterial color="#66757c" metalness={0.72} />
      </mesh>
    </group>
  );
}

function FactoryScene({ dark, animate, celestialSky, reducedMotion }: { dark: boolean; animate: boolean; celestialSky: boolean; reducedMotion: boolean }) {
  return (
    <>
      {celestialSky ? <FactorySky reducedMotion={reducedMotion} /> : <>
      <color attach="background" args={[dark ? "#071017" : "#516a74"]} />
      <fog attach="fog" args={[dark ? "#071017" : "#6d858d", 22, 48]} />
      <ambientLight intensity={dark ? 0.42 : 0.78} color={dark ? "#8aa5b1" : "#d9e7e9"} />
      <hemisphereLight args={[dark ? "#9bb6c1" : "#eef8f8", dark ? "#081014" : "#34464c", dark ? 0.72 : 1.05]} />
      <directionalLight position={[10, 14, 9]} intensity={dark ? 2.8 : 3.6} color={dark ? "#c9e1df" : "#fff4df"} castShadow shadow-mapSize={[1536, 1536]} shadow-camera-left={-14} shadow-camera-right={14} shadow-camera-top={12} shadow-camera-bottom={-10} />
      <directionalLight position={[-9, 5, -7]} intensity={dark ? 1.3 : 1.7} color="#4d98a4" />
      <pointLight position={[-5, 4, 7]} intensity={dark ? 9 : 5} distance={14} color="#e89648" />
      </>}
      <IndustrialComplex dark={dark} animate={animate} />

      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.5, 0]}>
        <planeGeometry args={[42, 34]} />
        <meshStandardMaterial color={dark ? "#10191d" : "#5c696d"} roughness={0.96} metalness={0.08} />
      </mesh>
      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.47, 8.6]}>
        <planeGeometry args={[25, 6]} />
        <meshStandardMaterial color={dark ? "#1a2429" : "#48575c"} roughness={0.88} />
      </mesh>
      {[-5.6, 0, 5.6].map((x) => (
        <mesh key={x} rotation={[-Math.PI / 2, 0, 0]} position={[x, -0.435, 8.6]}>
          <planeGeometry args={[3.3, 0.12]} />
          <meshBasicMaterial color={dark ? "#87979a" : "#d6dfde"} />
        </mesh>
      ))}
      <ContactShadows position={[0, -0.46, 0]} opacity={dark ? 0.7 : 0.42} scale={24} blur={2.8} far={12} />
      <OrbitControls makeDefault enablePan={false} enableZoom={false} enableRotate={false} target={[0, 2, 0]} autoRotate={animate} autoRotateSpeed={0.08} />
    </>
  );
}

export function AnimatedGarmentFactory({ compact = false, celestialSky = false }: { compact?: boolean; celestialSky?: boolean }) {
  const { theme } = useTheme();
  const [reducedMotion, setReducedMotion] = useState(false);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => setReducedMotion(media.matches);
    const updateVisibility = () => setVisible(document.visibilityState === "visible");
    updateMotion();
    updateVisibility();
    media.addEventListener("change", updateMotion);
    document.addEventListener("visibilitychange", updateVisibility);
    return () => {
      media.removeEventListener("change", updateMotion);
      document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, []);

  const animate = visible && !reducedMotion;
  return (
    <FactoryErrorBoundary>
      <div className={`animated-factory ${compact ? "compact" : ""}`}>
        <Canvas
          key={celestialSky ? "home-factory" : theme}
          aria-label={celestialSky ? "Garment factory with a decorative day and night sky" : "Animated exterior of a garment factory with decorative chimney smoke"}
          dpr={[1, 1.5]}
          frameloop={animate ? "always" : "demand"}
          shadows="percentage"
          camera={{ position: compact ? [14.2, 7.2, 17.8] : [13.2, 7.4, 16.8], fov: compact ? 38 : 35, near: 0.1, far: 70 }}
          gl={{ antialias: true, powerPreference: "high-performance", alpha: false }}
          fallback={celestialSky ? <div className="factory-fallback" role="img" aria-label="Garment factory illustration">The 3D factory sky is unavailable. All page actions remain usable.</div> : undefined}
          onCreated={({ gl }) => {
            gl.toneMapping = THREE.ACESFilmicToneMapping;
            gl.toneMappingExposure = theme === "dark" ? 1.18 : 1.08;
            gl.outputColorSpace = THREE.SRGBColorSpace;
            gl.shadowMap.type = THREE.PCFSoftShadowMap;
          }}
        >
          <FactoryScene dark={theme === "dark"} animate={animate} celestialSky={celestialSky} reducedMotion={reducedMotion} />
        </Canvas>
        <span className="factory-disclaimer">Decorative industrial visualization · not environmental data</span>
      </div>
    </FactoryErrorBoundary>
  );
}
