"use client";

import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { nextSkyPhase, SKY_TRANSITION_SECONDS, skyEase, skyPosition } from "@/lib/sky-orbit";
import { useTheme } from "./theme-provider";

const glowFragment = `
  varying vec2 vUv;
  uniform float opacity;
  uniform vec3 tint;
  void main() {
    float r = length(vUv - 0.5) * 2.0;
    float alpha = pow(max(0.0, 1.0 - r), 3.0) * opacity;
    gl_FragColor = vec4(tint, alpha);
  }
`;
const glowVertex = `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

function CelestialBody({ moon, bodyRef }: { moon?: boolean; bodyRef: React.RefObject<THREE.Group | null> }) {
  const glow = useMemo(() => ({ opacity: { value: 0 }, tint: { value: new THREE.Color(moon ? "#c3d5eb" : "#ffc46e") } }), [moon]);
  return (
    <group ref={bodyRef} name={moon ? "Moon" : "Sun"} visible={false}>
      <mesh>
        <sphereGeometry args={[1, 28, 20]} />
        <meshBasicMaterial color={moon ? "#cbd4dc" : "#ffdda1"} transparent opacity={0} fog={false} toneMapped={false} />
      </mesh>
      {moon && [[-.3, .24, .18], [.26, -.16, .23], [-.12, -.4, .1]].map(([x, y, radius], i) => (
        <mesh key={i} position={[x, y, Math.sqrt(1 - x * x - y * y)]}>
          <circleGeometry args={[radius, 16]} />
          <meshBasicMaterial color="#98a6b5" transparent opacity={0} depthWrite={false} fog={false} toneMapped={false} />
        </mesh>
      ))}
      <mesh position={[0, 0, -.05]} scale={moon ? 2.7 : 4.2}>
        <planeGeometry args={[2, 2]} />
        <shaderMaterial vertexShader={glowVertex} fragmentShader={glowFragment} uniforms={glow} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
    </group>
  );
}

export function FactorySky({ reducedMotion }: { reducedMotion: boolean }) {
  const { theme, ready } = useTheme();
  const dark = theme === "dark";
  const orbit = useRef({ phase: 0, start: 0, target: 0, elapsed: 0, dark, initialized: false });
  const sun = useRef<THREE.Group>(null);
  const moon = useRef<THREE.Group>(null);
  const sky = useRef<THREE.Color>(null);
  const fog = useRef<THREE.Fog>(null);
  const ambient = useRef<THREE.AmbientLight>(null);
  const hemisphere = useRef<THREE.HemisphereLight>(null);
  const keyLight = useRef<THREE.DirectionalLight>(null);
  const fill = useRef<THREE.DirectionalLight>(null);
  const colors = useMemo(() => ({ day: new THREE.Color("#a8c8da"), night: new THREE.Color("#233b50"), haze: new THREE.Color("#bfd4df"), warm: new THREE.Color("#fff0d5"), cool: new THREE.Color("#b7cee6"), position: new THREE.Vector3() }), []);

  useFrame(({ camera, gl, invalidate }, delta) => {
    const state = orbit.current;
    if (!ready) return;
    if (!state.initialized || reducedMotion) {
      state.phase = state.target = dark ? Math.PI : 0;
      state.dark = dark;
      state.initialized = true;
    } else if (state.dark !== dark) {
      // Retarget from the actual position, never queue cycles or reverse on rapid clicks.
      state.start = state.phase;
      state.target = nextSkyPhase(state.phase, dark);
      state.elapsed = 0;
      state.dark = dark;
    }
    if (state.phase !== state.target) {
      state.elapsed += delta;
      const t = skyEase(state.elapsed / SKY_TRANSITION_SECONDS);
      state.phase = t === 1 ? state.target : THREE.MathUtils.lerp(state.start, state.target, t);
      invalidate();
    }
    const night = (1 - Math.cos(state.phase)) / 2;
    sky.current?.copy(colors.day).lerp(colors.night, night);
    fog.current?.color.copy(colors.haze).lerp(colors.night, night);
    if (ambient.current) ambient.current.intensity = THREE.MathUtils.lerp(.78, .5, night);
    if (hemisphere.current) hemisphere.current.intensity = THREE.MathUtils.lerp(1.05, .78, night);
    if (keyLight.current) {
      keyLight.current.intensity = THREE.MathUtils.lerp(3.6, 2.8, night);
      keyLight.current.color.copy(colors.warm).lerp(colors.cool, night);
    }
    if (fill.current) fill.current.intensity = THREE.MathUtils.lerp(1.7, 1.3, night);
    gl.toneMappingExposure = THREE.MathUtils.lerp(1.08, 1.18, night);

    // Camera-facing world-space spheres stay in the upper-left sky on resize and
    // during the existing slow factory orbit, away from the central chimney.
    const perspective = camera as THREE.PerspectiveCamera;
    const depth = 36;
    const halfHeight = Math.tan(THREE.MathUtils.degToRad(perspective.getEffectiveFOV()) / 2) * depth;
    const halfWidth = halfHeight * perspective.aspect;
    [sun.current, moon.current].forEach((body, index) => {
      if (!body) return;
      const position = skyPosition(state.phase + index * Math.PI);
      body.visible = position.opacity > 0;
      body.position.copy(colors.position.set(position.x * halfWidth, position.y * halfHeight, -depth).applyQuaternion(camera.quaternion).add(camera.position));
      body.quaternion.copy(camera.quaternion);
      body.scale.setScalar(Math.min(halfWidth * .065, halfHeight * .09));
      body.children.forEach((child) => {
        const material = (child as THREE.Mesh).material;
        if (material instanceof THREE.ShaderMaterial) material.uniforms.opacity.value = position.opacity * (index ? .2 : .75);
        else if (material instanceof THREE.MeshBasicMaterial) material.opacity = position.opacity * (child === body.children[0] ? 1 : .23);
      });
    });
  });

  return (
    <>
      <color ref={sky} attach="background" args={["#a8c8da"]} />
      <fog ref={fog} attach="fog" args={["#bfd4df", 22, 48]} />
      <ambientLight ref={ambient} intensity={.78} color="#d9e7e9" />
      <hemisphereLight ref={hemisphere} args={["#cddfe9", "#263840", 1.05]} />
      <directionalLight ref={keyLight} position={[-10, 14, 9]} intensity={3.6} castShadow shadow-mapSize={[1536, 1536]} shadow-camera-left={-14} shadow-camera-right={14} shadow-camera-top={12} shadow-camera-bottom={-10} />
      <directionalLight ref={fill} position={[-9, 5, -7]} intensity={1.7} color="#4d98a4" />
      <pointLight position={[-5, 4, 7]} intensity={5} distance={14} color="#e89648" />
      <CelestialBody bodyRef={sun} />
      <CelestialBody moon bodyRef={moon} />
    </>
  );
}
