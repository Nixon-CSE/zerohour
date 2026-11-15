"use client";
/**
 * The Hourglass: ZeroHour's time lock, drawn literally.
 *
 * The sand is not decoration. `progress` is how far the current 5-minute keyper round has run
 * on QoreChain's clock, so the top bulb empties exactly when the next round's seeds may be
 * posted. The three orbs are the keypers of the latest exam: solid when their seed is public.
 */
import { Canvas, useFrame } from "@react-three/fiber";
import { Environment, Float, Lightformer } from "@react-three/drei";
import { useMemo, useRef } from "react";
import * as THREE from "three";

const H = 1.25; // half height of each bulb
const R = 0.95; // bulb radius
const NECK = 0.06;

/** Radius of the glass at height y (y from -H..H), a soft double bulb. */
function bulb(y: number) {
  const t = Math.abs(y) / H; // 0 at the neck, 1 at the caps
  const s = Math.sin(Math.min(1, t) * Math.PI * 0.92);
  return NECK + (R - NECK) * Math.pow(s, 0.85) * (t > 0.92 ? 1 - (t - 0.92) * 2.2 : 1);
}

function profile(from: number, to: number, inset = 0, steps = 64) {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= steps; i++) {
    const y = from + ((to - from) * i) / steps;
    pts.push(new THREE.Vector2(Math.max(0.0005, bulb(y) - inset), y));
  }
  return pts;
}

function Glass() {
  const geo = useMemo(() => new THREE.LatheGeometry(profile(-H, H), 96), []);
  return (
    <mesh geometry={geo}>
      <meshPhysicalMaterial
        transmission={1}
        thickness={0.35}
        roughness={0.04}
        ior={1.45}
        clearcoat={1}
        attenuationColor="#cfe0ff"
        attenuationDistance={4}
        color="#ffffff"
        side={THREE.DoubleSide}
        transparent
      />
    </mesh>
  );
}

function Frame() {
  const cap = useMemo(() => new THREE.CylinderGeometry(1.18, 1.18, 0.14, 64), []);
  const rod = useMemo(() => new THREE.CylinderGeometry(0.035, 0.035, 2 * H + 0.14, 16), []);
  const mat = <meshStandardMaterial color="#2b2d33" metalness={0.85} roughness={0.28} />;
  return (
    <group>
      <mesh geometry={cap} position={[0, H + 0.07, 0]}>{mat}</mesh>
      <mesh geometry={cap} position={[0, -H - 0.07, 0]}>{mat}</mesh>
      {[0, 1, 2].map((i) => {
        const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
        return <mesh key={i} geometry={rod} position={[Math.cos(a) * 1.06, 0, Math.sin(a) * 1.06]}>{mat}</mesh>;
      })}
    </group>
  );
}

const SAND = "#e0457b";

/** Sand in both bulbs plus the falling stream, all driven by `progress` (0..1). */
function Sand({ progress, still }: { progress: React.RefObject<number>; still: boolean }) {
  const top = useRef<THREE.Mesh>(null!);
  const surface = useRef<THREE.Mesh>(null!);
  const clip = useMemo(() => new THREE.Plane(new THREE.Vector3(0, -1, 0), 0), []);
  const bottom = useRef<THREE.Mesh>(null!);
  const stream = useRef<THREE.InstancedMesh>(null!);
  const N = 70;
  const topGeo = useMemo(() => new THREE.LatheGeometry(profile(0.02, H * 0.78, 0.045, 40).concat([new THREE.Vector2(0.0005, H * 0.78)]), 64), []);
  const bottomGeo = useMemo(() => new THREE.ConeGeometry(R * 0.86, 1, 64, 1, false), []);
  const grain = useMemo(() => new THREE.SphereGeometry(0.014, 6, 6), []);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const seeds = useMemo(() => Array.from({ length: N }, (_, i) => ({ off: i / N, x: (Math.random() - 0.5) * 0.03, z: (Math.random() - 0.5) * 0.03 })), []);

  useFrame(({ clock }) => {
    const p = THREE.MathUtils.clamp(progress.current ?? 0, 0, 1);
    // top: the surface drains downward; everything above `level` is clipped, the narrow part near the neck empties last
    const left = 1 - p;
    const level = 0.02 + (H * 0.78 - 0.02) * Math.pow(left, 0.6);
    clip.constant = level;
    top.current.visible = surface.current.visible = left > 0.004;
    const r = Math.max(0.001, bulb(level) - 0.045);
    surface.current.position.y = level;
    surface.current.scale.set(r, r, 1);
    // bottom: a cone pile that grows from the floor
    const h = 0.05 + p * H * 0.72;
    bottom.current.scale.set(0.35 + 0.65 * Math.sqrt(p), h, 0.35 + 0.65 * Math.sqrt(p));
    bottom.current.position.y = -H + h / 2;
    // stream: grains fall from the neck to the pile while there is sand left
    const floor = -H + h;
    const t = clock.elapsedTime;
    seeds.forEach((s, i) => {
      const f = still ? s.off : (s.off + t * 0.9) % 1;
      const y = THREE.MathUtils.lerp(0, floor, f);
      dummy.position.set(s.x * (1 + f * 2), y, s.z * (1 + f * 2));
      dummy.scale.setScalar(left > 0.004 ? 1 : 0);
      dummy.updateMatrix();
      stream.current.setMatrixAt(i, dummy.matrix);
    });
    stream.current.instanceMatrix.needsUpdate = true;
  });

  const sandMat = <meshStandardMaterial color={SAND} emissive={SAND} emissiveIntensity={0.35} roughness={0.9} />;
  return (
    <group>
      <mesh ref={top} geometry={topGeo}>
        <meshStandardMaterial color={SAND} emissive={SAND} emissiveIntensity={0.35} roughness={0.9} clippingPlanes={[clip]} side={THREE.DoubleSide} />
      </mesh>
      <mesh ref={surface} rotation-x={-Math.PI / 2}>
        <circleGeometry args={[1, 64]} />
        {sandMat}
      </mesh>
      <mesh ref={bottom} geometry={bottomGeo}>{sandMat}</mesh>
      <instancedMesh ref={stream} args={[grain, undefined, N]}>
        <meshStandardMaterial color={SAND} emissive={SAND} emissiveIntensity={0.8} />
      </instancedMesh>
    </group>
  );
}

/** Keyper orbs circling the glass: solid graphite-blue once their seed is public, hollow magenta while sealed. */
function Keypers({ released, still }: { released: boolean[]; still: boolean }) {
  const g = useRef<THREE.Group>(null!);
  useFrame((_, dt) => {
    if (!still) g.current.rotation.y += dt * 0.18;
  });
  return (
    <group ref={g}>
      {released.map((on, i) => {
        const a = (i / released.length) * Math.PI * 2;
        const y = [0.55, -0.15, -0.75][i % 3];
        return (
          <Float key={i} speed={still ? 0 : 1.4} floatIntensity={0.25} rotationIntensity={0}>
            <mesh position={[Math.cos(a) * 1.5, y, Math.sin(a) * 1.5]}>
              <sphereGeometry args={[0.16, 32, 32]} />
              {on ? (
                <meshStandardMaterial color="#93a9ff" emissive="#3b5bdb" emissiveIntensity={0.9} metalness={0.3} roughness={0.25} />
              ) : (
                <meshStandardMaterial color={SAND} emissive={SAND} emissiveIntensity={0.6} wireframe />
              )}
            </mesh>
          </Float>
        );
      })}
    </group>
  );
}

function Rig({ children, still }: { children: React.ReactNode; still: boolean }) {
  const g = useRef<THREE.Group>(null!);
  const born = useRef<number | null>(null);
  useFrame(({ pointer, clock }) => {
    if (born.current === null) born.current = clock.elapsedTime;
    // one entrance: rise and turn into place over ~1.4 s
    const e = still ? 1 : Math.min(1, (clock.elapsedTime - born.current) / 1.4);
    const ease = 1 - Math.pow(1 - e, 3);
    g.current.position.y = (1 - ease) * -0.8;
    g.current.scale.setScalar(0.85 + 0.15 * ease);
    const ty = still ? -0.35 : pointer.x * 0.35 - 0.35 + (1 - ease) * 1.2;
    const tx = still ? 0.08 : -pointer.y * 0.12 + 0.08;
    g.current.rotation.y = THREE.MathUtils.lerp(g.current.rotation.y, ty, 0.05);
    g.current.rotation.x = THREE.MathUtils.lerp(g.current.rotation.x, tx, 0.05);
  });
  return <group ref={g}>{children}</group>;
}

export default function HourglassScene({ progress, released, still = false }: { progress: React.RefObject<number>; released: boolean[]; still?: boolean }) {
  return (
    <Canvas camera={{ position: [0, 0.2, 6.8], fov: 38 }} dpr={[1, 2]} gl={{ antialias: true, alpha: true }} onCreated={({ gl }) => { gl.localClippingEnabled = true; }} frameloop={still ? "demand" : "always"}>
      <ambientLight intensity={0.35} />
      <directionalLight position={[3, 4, 5]} intensity={1.4} />
      <pointLight position={[0, -1.1, 0]} intensity={2.2} color={SAND} distance={3} />
      <Rig still={still}>
        <Frame />
        <Glass />
        <Sand progress={progress} still={still} />
        <Keypers released={released} still={still} />
      </Rig>
      {/* procedural studio light: no HDR download, nothing fetched */}
      <Environment resolution={256}>
        <Lightformer intensity={2.4} position={[0, 4, -6]} scale={[10, 3, 1]} color="#ffffff" />
        <Lightformer intensity={1.2} position={[-5, 0, 2]} rotation-y={Math.PI / 2} scale={[6, 4, 1]} color="#cfd8ff" />
        <Lightformer intensity={1.6} position={[5, 1, 1]} rotation-y={-Math.PI / 2} scale={[4, 6, 1]} color="#ffd0df" />
      </Environment>
    </Canvas>
  );
}
