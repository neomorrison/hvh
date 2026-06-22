/* ============================== [CORE] ==============================
   Renderer, scene, camera and lighting.  Imported once; everything else
   adds meshes to `scene` and renders through `camera`/`renderer`.        */
import * as THREE from 'three';

export const app = document.getElementById('app');

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x10141b);
scene.fog = new THREE.Fog(0x10141b, 1400, 4200);

export const camera = new THREE.PerspectiveCamera(74, innerWidth / innerHeight, 1, 9000);
scene.add(camera);  // so the first-person weapon viewmodel (a child of camera) renders

export const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// lighting
const hemi = new THREE.HemisphereLight(0xb8c6e0, 0x35302a, 0.85); scene.add(hemi);
export const sun = new THREE.DirectionalLight(0xfff2d8, 1.1);
sun.position.set(-1200, 2200, 800); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048); sun.shadow.camera.near = 200; sun.shadow.camera.far = 6000;
sun.shadow.camera.left = -2200; sun.shadow.camera.right = 2200; sun.shadow.camera.top = 1800; sun.shadow.camera.bottom = -1800;
scene.add(sun);
