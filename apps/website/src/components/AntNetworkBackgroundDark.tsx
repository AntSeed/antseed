import {useEffect, useRef} from 'react';
import * as THREE from 'three';

/**
 * Animated Three.js background showing a P2P network with ants carrying seeds.
 * Adapted from Eylon's concept to match the AntSeed dark theme.
 * Renders as a fixed full-viewport canvas behind all page content.
 */
export default function AntNetworkBackground() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // -- Theme colors --
    const BG = 0x0a0e14;
    const ACCENT = 0x1FD87A;
    const ACCENT_DIM = 0x1a9e5f;
    const ERROR = 0xea580c;

    // -- State --
    const uiState = {scrollY: 0, mouseX: 0, mouseY: 0};
    const onScroll = () => (uiState.scrollY = window.scrollY);
    const onMouse = (e: MouseEvent) => {
      uiState.mouseX = (e.clientX / window.innerWidth) * 2 - 1;
      uiState.mouseY = -(e.clientY / window.innerHeight) * 2 + 1;
    };
    window.addEventListener('scroll', onScroll, {passive: true});
    window.addEventListener('mousemove', onMouse, {passive: true});

    // -- Scene --
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(BG, 0.012);

    const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 0, 45);

    const renderer = new THREE.WebGLRenderer({antialias: true, alpha: true, powerPreference: 'high-performance'});
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(BG, 0);
    container.appendChild(renderer.domElement);

    // -- Lights --
    scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(20, 30, 20);
    scene.add(dirLight);

    // -- Materials --
    const nodeMaterial = new THREE.MeshPhysicalMaterial({
      color: ACCENT,
      roughness: 0.3,
      transmission: 0.85,
      thickness: 2,
      transparent: true,
      opacity: 0.5,
    });

    const activeLineMat = new THREE.LineBasicMaterial({
      color: ACCENT_DIM,
      transparent: true,
      opacity: 0.12,
    });

    const errorLineMat = new THREE.LineBasicMaterial({
      color: ERROR,
      transparent: true,
      opacity: 0.6,
    });

    // -- Procedural ant --
    function createProceduralAnt(): THREE.Group {
      const group = new THREE.Group();
      const bodyMat = new THREE.MeshStandardMaterial({color: 0x1a6b55, roughness: 0.5, emissive: 0x0d3a2e, emissiveIntensity: 0.4});
      const legMat = new THREE.MeshStandardMaterial({color: 0x1a6b55, roughness: 0.6, emissive: 0x0d3a2e, emissiveIntensity: 0.3});

      // Abdomen — large rear segment, slightly elongated
      const abdomen = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 10), bodyMat);
      abdomen.scale.set(1, 0.85, 0.85);
      abdomen.position.set(-0.32, 0, 0);
      group.add(abdomen);

      // Thorax — smaller middle segment
      const thorax = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 10), bodyMat);
      thorax.scale.set(1.1, 0.8, 0.8);
      thorax.position.set(0.0, 0, 0);
      group.add(thorax);

      // Head — round front
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 10), bodyMat);
      head.position.set(0.26, 0, 0);
      group.add(head);

      // Eyes — two small bright dots
      const eyeMat = new THREE.MeshBasicMaterial({color: ACCENT, transparent: true, opacity: 0.7});
      const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.025, 6, 6), eyeMat);
      eyeL.position.set(0.35, 0.04, 0.08);
      group.add(eyeL);
      const eyeR = new THREE.Mesh(new THREE.SphereGeometry(0.025, 6, 6), eyeMat);
      eyeR.position.set(0.35, 0.04, -0.08);
      group.add(eyeR);

      // Antennae — two curved feelers
      function createAntenna(side: number): THREE.Line {
        const pts = [
          new THREE.Vector3(0.34, 0.06, side * 0.06),
          new THREE.Vector3(0.42, 0.16, side * 0.12),
          new THREE.Vector3(0.50, 0.22, side * 0.18),
        ];
        const curve = new THREE.CatmullRomCurve3(pts);
        const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(8));
        return new THREE.Line(geo, new THREE.LineBasicMaterial({color: 0x1FD87A, linewidth: 1}));
      }
      group.add(createAntenna(1));
      group.add(createAntenna(-1));

      // Antenna tips — small glowing dots
      const tipMat = new THREE.MeshBasicMaterial({color: ACCENT, transparent: true, opacity: 0.5});
      const tipL = new THREE.Mesh(new THREE.SphereGeometry(0.02, 6, 6), tipMat);
      tipL.position.set(0.50, 0.22, 0.18);
      group.add(tipL);
      const tipR = new THREE.Mesh(new THREE.SphereGeometry(0.02, 6, 6), tipMat);
      tipR.position.set(0.50, 0.22, -0.18);
      group.add(tipR);

      // Legs — 3 pairs attached to the thorax, angled down and out
      function createLeg(xOff: number, side: number, angle: number): THREE.Group {
        const leg = new THREE.Group();
        // Upper segment
        const upper = new THREE.Mesh(
          new THREE.CylinderGeometry(0.015, 0.012, 0.18, 5),
          legMat,
        );
        upper.position.set(0, -0.08, side * 0.06);
        upper.rotation.z = side * angle;
        upper.rotation.x = side * 0.3;
        leg.add(upper);
        // Lower segment
        const lower = new THREE.Mesh(
          new THREE.CylinderGeometry(0.012, 0.008, 0.16, 5),
          legMat,
        );
        lower.position.set(0, -0.2, side * 0.14);
        lower.rotation.z = side * (angle + 0.3);
        lower.rotation.x = side * 0.2;
        leg.add(lower);
        leg.position.x = xOff;
        return leg;
      }
      // Front legs
      group.add(createLeg(0.1, 1, 0.6));
      group.add(createLeg(0.1, -1, 0.6));
      // Middle legs
      group.add(createLeg(-0.02, 1, 0.8));
      group.add(createLeg(-0.02, -1, 0.8));
      // Back legs
      group.add(createLeg(-0.15, 1, 1.0));
      group.add(createLeg(-0.15, -1, 1.0));

      // Seed on back — glowing green
      const seed = new THREE.Mesh(
        new THREE.SphereGeometry(0.11, 10, 10),
        new THREE.MeshBasicMaterial({color: ACCENT}),
      );
      seed.position.set(-0.05, 0.18, 0);
      group.add(seed);

      // Seed glow halo
      const glow = new THREE.Mesh(
        new THREE.SphereGeometry(0.16, 10, 10),
        new THREE.MeshBasicMaterial({color: ACCENT, transparent: true, opacity: 0.15}),
      );
      glow.position.set(-0.05, 0.18, 0);
      group.add(glow);

      group.scale.set(1.0, 1.0, 1.0);
      return group;
    }

    const antTemplate = createProceduralAnt();

    // -- Network --
    interface Packet {
      mesh: THREE.Group;
      progress: number;
      speed: number;
    }
    interface Edge {
      startNode: THREE.Mesh;
      endNode: THREE.Mesh;
      curve: THREE.CatmullRomCurve3;
      line: THREE.Line;
      packets: Packet[];
      active: boolean;
    }

    const nodes: THREE.Mesh[] = [];
    const edges: Edge[] = [];

    // Create nodes
    for (let i = 0; i < 40; i++) {
      const mesh = new THREE.Mesh(
        new THREE.IcosahedronGeometry(Math.random() * 0.8 + 0.4, 0),
        nodeMaterial,
      );
      mesh.position.set(
        (Math.random() - 0.5) * 60,
        30 - Math.random() * 150,
        (Math.random() - 0.5) * 20 - 5,
      );
      (mesh as any).userData = {
        baseY: mesh.position.y,
        offset: Math.random() * Math.PI * 2,
      };
      scene.add(mesh);
      nodes.push(mesh);
    }

    function createConnection(startNode: THREE.Mesh, endNode: THREE.Mesh) {
      const points: THREE.Vector3[] = [];
      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        const pt = new THREE.Vector3().lerpVectors(startNode.position, endNode.position, t);
        if (i > 0 && i < 10) {
          pt.x += Math.sin(t * Math.PI) * (Math.random() * 4 - 2);
          pt.z += Math.sin(t * Math.PI) * (Math.random() * 4 - 2);
        }
        points.push(pt);
      }
      const curve = new THREE.CatmullRomCurve3(points);
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(curve.getPoints(50)),
        activeLineMat,
      );
      scene.add(line);

      const packets: Packet[] = [];
      for (let j = 0; j < 2; j++) {
        const ant = antTemplate.clone();
        scene.add(ant);
        packets.push({mesh: ant, progress: Math.random(), speed: 0.003 + Math.random() * 0.004});
      }
      edges.push({startNode, endNode, curve, line, packets, active: true});
    }

    // Connect nodes
    for (let i = 0; i < nodes.length; i++) {
      const candidates = nodes.filter(
        (n) => n.position.y < nodes[i].position.y && n.position.y > nodes[i].position.y - 30,
      );
      if (candidates.length > 0) {
        createConnection(nodes[i], candidates[Math.floor(Math.random() * candidates.length)]);
      }
    }

    // Self-healing algorithm
    const healInterval = setInterval(() => {
      if (edges.length === 0) return;
      const activeEdges = edges.filter((e) => e.active);
      if (activeEdges.length === 0) return;

      const edge = activeEdges[Math.floor(Math.random() * activeEdges.length)];
      edge.active = false;
      edge.line.material = errorLineMat;

      setTimeout(() => {
        scene.remove(edge.line);
        edge.packets.forEach((p) => scene.remove(p.mesh));
        const c = nodes.filter(
          (n) =>
            n !== edge.startNode &&
            n !== edge.endNode &&
            Math.abs(n.position.y - edge.startNode.position.y) < 30,
        );
        if (c.length > 0) {
          createConnection(edge.startNode, c[Math.floor(Math.random() * c.length)]);
        }
      }, 800);
    }, 3000);

    // -- Animate --
    const clock = new THREE.Clock();
    let animId: number;

    function animate() {
      animId = requestAnimationFrame(animate);
      const time = clock.getElapsedTime();

      nodes.forEach((node) => {
        node.rotation.x += 0.001;
        node.rotation.y += 0.002;
        node.position.y = (node as any).userData.baseY + Math.sin(time + (node as any).userData.offset) * 1.5;
      });

      edges.forEach((edge) => {
        if (edge.active) {
          edge.packets.forEach((packet) => {
            packet.progress += packet.speed;
            if (packet.progress > 1) packet.progress = 0;
            packet.mesh.position.copy(edge.curve.getPointAt(packet.progress));
            packet.mesh.lookAt(edge.curve.getPointAt(Math.min(packet.progress + 0.01, 1)));
          });
        }
      });

      camera.position.y += (-(uiState.scrollY * 0.035) - camera.position.y) * 0.1;
      camera.position.x += (uiState.mouseX * 3 - camera.position.x) * 0.05;
      renderer.render(scene, camera);
    }

    animate();

    // -- Resize --
    const onResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', onResize);

    // -- Cleanup --
    return () => {
      cancelAnimationFrame(animId);
      clearInterval(healInterval);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('mousemove', onMouse);
      window.removeEventListener('resize', onResize);
      renderer.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        zIndex: 0,
        pointerEvents: 'none',
      }}
    />
  );
}
