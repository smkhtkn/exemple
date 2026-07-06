import * as THREE from 'three';

const COLOR_URL = 'kontext_photo_final.png';
const DEPTH_URL = 'kontext_photo_final_depth.png';

// --- настройки киоска --------------------------------------------------------
// Углы можно переопределить в URL: ?yaw=15&pitch=8&relief=0.25
const params = new URLSearchParams(location.search);
const LIMITS = {
  yaw:   THREE.MathUtils.degToRad(Number(params.get('yaw'))   || 12),  // ± по горизонтали
  pitch: THREE.MathUtils.degToRad(Number(params.get('pitch')) || 6),   // ± по вертикали
  distMin: 1.65, distBase: 2.0, distMax: 2.35,
};
const RELIEF  = Number(params.get('relief')) || 0.22;
const IDLE_MS = 6000;                   // пауза до авто-«дыхания» камеры
const DAMP    = 4.0;                    // плавность (демпфирование)

// --- рендерер и сцена ---------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene  = new THREE.Scene();
scene.background = new THREE.Color(0x0c0f13);
const camera = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.05, 20);

// --- текстуры и рельефная плоскость -------------------------------------------
const loader = new THREE.TextureLoader();
const [colorTex, depthTex] = await Promise.all([
  loader.loadAsync(COLOR_URL),
  loader.loadAsync(DEPTH_URL),
]).catch((e) => { throw new Error('Не удалось загрузить текстуры (проверьте пути и что сервер запущен из папки 2d_depth): ' + e); });
colorTex.colorSpace = THREE.SRGBColorSpace;
colorTex.anisotropy = renderer.capabilities.getMaxAnisotropy();

const aspect = colorTex.image.width / colorTex.image.height;
const SEG = 640;
const geo = new THREE.PlaneGeometry(aspect, 1, SEG, Math.round(SEG / aspect));

const uniforms = { uDepth: { value: depthTex }, uScale: { value: RELIEF } };
const mat = new THREE.MeshBasicMaterial({ map: colorTex });
mat.onBeforeCompile = (s) => {
  Object.assign(s.uniforms, uniforms);
  s.vertexShader = s.vertexShader
    .replace('#include <common>',
      '#include <common>\nuniform sampler2D uDepth;\nuniform float uScale;')
    .replace('#include <begin_vertex>',
      `#include <begin_vertex>
       float dpt = texture2D(uDepth, uv).r;
       transformed.z += (dpt - 0.5) * uScale;`);   // центрируем рельеф вокруг оси вращения
};
scene.add(new THREE.Mesh(geo, mat));

// --- управление: перетаскивание, пинч/колесо, авто-«дыхание» -------------------
const state  = { yaw: 0, pitch: 0, dist: LIMITS.distBase };
const target = { yaw: 0, pitch: 0, dist: LIMITS.distBase };
const clamp  = THREE.MathUtils.clamp;
const hint   = document.getElementById('hint');
let lastActive = performance.now();
const poke = () => { lastActive = performance.now(); hint.style.opacity = '0'; };

const pointers = new Map();
const el = renderer.domElement;

el.addEventListener('pointerdown', (e) => {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  el.setPointerCapture(e.pointerId);
  poke();
});
el.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  if (pointers.size === 2) {                                   // пинч-зум
    const pts  = [...pointers.values()];
    const prev = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    p.x = e.clientX; p.y = e.clientY;
    const cur  = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    target.dist = clamp(target.dist * prev / Math.max(cur, 1), LIMITS.distMin, LIMITS.distMax);
  } else {                                                     // поворот
    target.yaw   = clamp(target.yaw   - (e.clientX - p.x) * 0.0035, -LIMITS.yaw,   LIMITS.yaw);
    target.pitch = clamp(target.pitch + (e.clientY - p.y) * 0.0025, -LIMITS.pitch, LIMITS.pitch);
    p.x = e.clientX; p.y = e.clientY;
  }
  poke();
});
const drop = (e) => { pointers.delete(e.pointerId); poke(); };
el.addEventListener('pointerup', drop);
el.addEventListener('pointercancel', drop);

el.addEventListener('wheel', (e) => {
  e.preventDefault();
  target.dist = clamp(target.dist + e.deltaY * 0.0012, LIMITS.distMin, LIMITS.distMax);
  poke();
}, { passive: false });

window.addEventListener('contextmenu', (e) => e.preventDefault());

// калибровка на месте: [ и ] — сила рельефа, R — сброс
window.addEventListener('keydown', (e) => {
  if (e.key === '[') uniforms.uScale.value = Math.max(0.05, uniforms.uScale.value - 0.02);
  if (e.key === ']') uniforms.uScale.value = Math.min(0.60, uniforms.uScale.value + 0.02);
  if (e.key === 'r' || e.key === 'R') Object.assign(target, { yaw: 0, pitch: 0, dist: LIMITS.distBase });
  console.log('relief =', uniforms.uScale.value.toFixed(2));
});

// --- цикл ----------------------------------------------------------------------
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t  = clock.elapsedTime;

  if (pointers.size === 0 && performance.now() - lastActive > IDLE_MS) {
    target.yaw   = Math.sin(t * 0.35) * LIMITS.yaw   * 0.55;   // медленное «дыхание»
    target.pitch = Math.sin(t * 0.23) * LIMITS.pitch * 0.35;
    target.dist += (LIMITS.distBase - target.dist) * dt;
  }

  const k = 1 - Math.exp(-DAMP * dt);                          // сглаживание, независимое от FPS
  state.yaw   += (target.yaw   - state.yaw)   * k;
  state.pitch += (target.pitch - state.pitch) * k;
  state.dist  += (target.dist  - state.dist)  * k;

  camera.position.set(
    Math.sin(state.yaw) * Math.cos(state.pitch),
    Math.sin(state.pitch),
    Math.cos(state.yaw) * Math.cos(state.pitch),
  ).multiplyScalar(state.dist);
  camera.lookAt(0, 0, 0);

  renderer.render(scene, camera);
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
