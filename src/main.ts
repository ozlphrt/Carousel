import './style.css'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js'
import GUI from 'lil-gui'

// --- Simple 2D Noise Implementation (Simplex-like) ---
const NOISE_PERM = new Uint8Array(512)
const NOISE_GRAD = [[1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]]
for (let i = 0; i < 256; i++) NOISE_PERM[i] = i
for (let i = 255; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1))
  ;[NOISE_PERM[i], NOISE_PERM[j]] = [NOISE_PERM[j], NOISE_PERM[i]]
}
for (let i = 0; i < 256; i++) NOISE_PERM[i + 256] = NOISE_PERM[i]

function noise2D(x: number, y: number): number {
  const X = Math.floor(x) & 255
  const Y = Math.floor(y) & 255
  const xf = x - Math.floor(x)
  const yf = y - Math.floor(y)
  const u = xf * xf * (3 - 2 * xf)
  const v = yf * yf * (3 - 2 * yf)
  const aa = NOISE_PERM[NOISE_PERM[X] + Y]
  const ab = NOISE_PERM[NOISE_PERM[X] + Y + 1]
  const ba = NOISE_PERM[NOISE_PERM[X + 1] + Y]
  const bb = NOISE_PERM[NOISE_PERM[X + 1] + Y + 1]
  const gradAA = NOISE_GRAD[aa & 7]
  const gradBA = NOISE_GRAD[ba & 7]
  const gradAB = NOISE_GRAD[ab & 7]
  const gradBB = NOISE_GRAD[bb & 7]
  const n00 = gradAA[0] * xf + gradAA[1] * yf
  const n10 = gradBA[0] * (xf - 1) + gradBA[1] * yf
  const n01 = gradAB[0] * xf + gradAB[1] * (yf - 1)
  const n11 = gradBB[0] * (xf - 1) + gradBB[1] * (yf - 1)
  const nx0 = n00 * (1 - u) + n10 * u
  const nx1 = n01 * (1 - u) + n11 * u
  return nx0 * (1 - v) + nx1 * v
}

// --- Configuration ---
const config = {
  platformRadius: 10,
  poleRadius: 1,
  poleHeight: 0.9,
  particleCount: 15721,
  particleRadius: 0.08,
  backgroundColor: '#2a2a2a',
  platformColor: '#5a5a5a',
  obstacleColor: '#5a5a5a',
  poleColor: '#0088ff',
  particleColor: '#00e5ff',
  speed: 0.195,
  separationForce: 0.288,
  centrifugalForce: 0,  // Was -0.2 which pushed particles AWAY from pole
  vortexStrength: 0,
  poleOpacity: 0.343,
  bloomStrength: 0.1398,
  bloomRadius: 0.5,
  bloomThreshold: 0,
  obstacleCount: 15,
  obstacleRadius: 0.3,
  debugMode: false,
  showTrails: false,
  trailLength: 30,
  showPheromones: false,
  // New visual settings
  enableBobbing: true,
  bobbingIntensity: 0.012,
  enableDOF: false,
  dofFocus: 5.0,
  dofAperture: 0.002,
  // New physics settings
  densitySlowdown: 0.08,
  alignmentForce: 0.02,
  anticipationDistance: 0.5,
  turbulenceStrength: 0.003,
  orbitLayers: 4
}

// --- Global Data definitions ---
const MAX_PARTICLE_COUNT = 20000
config.particleCount = 100

// STRIDE 19 for extra state data
// 0:x, 1:z, 2:vx, 3:vz, 4:r, 5:speedMult, 6:agility, 7:state, 8:accumAngle, 9:baseColor
// 10:orbitRadius, 11:group, 12:mass, 13:personalSpace, 14:phase, 15:orbitLayer, 16:colorBlend, 17:wanderAngle
// 18:leavingTime (how long in LEAVING state)
const STRIDE = 19
const OFFSET = {
  X: 0, Z: 1, VX: 2, VZ: 3, RADIUS: 4, SPEED_MULT: 5, AGILITY: 6, STATE: 7,
  ACCUM_ANGLE: 8, BASE_COLOR: 9, ORBIT_RADIUS: 10, GROUP: 11, MASS: 12,
  PERSONAL_SPACE: 13, PHASE: 14, ORBIT_LAYER: 15, COLOR_BLEND: 16, WANDER_ANGLE: 17,
  LEAVING_TIME: 18
}
const particles = new Float32Array(MAX_PARTICLE_COUNT * STRIDE)

// Grid
const GRID_DIM = 100
const gridHead = new Int32Array(GRID_DIM * GRID_DIM)
const gridNext = new Int32Array(MAX_PARTICLE_COUNT)

// Obstacle Data
const obstacleData = new Float32Array(config.obstacleCount * 3)
const obstacleMeshes: THREE.Mesh[] = []

// Interaction State
type DragMode = 'NONE' | 'MOVE'
let dragMode: DragMode = 'NONE'
let dragOffset = new THREE.Vector3()
let raycaster = new THREE.Raycaster()
let mouse = new THREE.Vector2()

// --- Scene Setup ---
const canvas = document.createElement('canvas')
document.body.appendChild(canvas)

const scene = new THREE.Scene()
scene.background = new THREE.Color(config.backgroundColor)
scene.fog = new THREE.FogExp2(config.backgroundColor, 0.02)

// --- Trail System ---
// Flattened history buffer: [p0_trail0_x, p0_trail0_y, p0_trail0_z, p0_trail1_x, ...]
// BUT better layout for LineSegments memory locality:
// We need constant segments. 
// Let's allocate MAXIMUM buffers, but we can't draw ALL lines every frame efficiently if we update the buffer geometry.
// Actually, updating a few thousand float attributes is fast in JS/WebGL.

const MAX_TRAIL_LENGTH = 50

// Per particle: ring buffer state
const trailHeads = new Int32Array(MAX_PARTICLE_COUNT).fill(0)
// The actual position history storage [ParticleID][HistoryIndex][3] -> Flattened: P * L * 3
const trailHistory = new Float32Array(MAX_PARTICLE_COUNT * MAX_TRAIL_LENGTH * 3)

// The geometry for LineSegments
// Each particle has (L-1) segments.
// Total vertices = MAX_PARTICLE_COUNT * (MAX_TRAIL_LENGTH - 1) * 2
const SEGMENTS_PER_PARTICLE = MAX_TRAIL_LENGTH - 1
const TRAIL_VERTEX_COUNT = MAX_PARTICLE_COUNT * SEGMENTS_PER_PARTICLE * 2
const trailGeometry = new THREE.BufferGeometry()
const trailPositions = new Float32Array(TRAIL_VERTEX_COUNT * 3)
trailGeometry.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3))

// Pre-fill history with far away points so we don't draw lines at 0,0,0 initially
for (let i = 0; i < trailHistory.length; i++) {
  trailHistory[i] = 99999
}
for (let i = 0; i < trailPositions.length; i++) {
  trailPositions[i] = 99999
}

const trailMaterial = new THREE.LineBasicMaterial({
  color: 0x88ff88,  // Soft green trail (visible against all groups)
  transparent: true,
  opacity: 0.5,
  blending: THREE.AdditiveBlending,
  depthWrite: false
})
const trailMesh = new THREE.LineSegments(trailGeometry, trailMaterial)
trailMesh.frustumCulled = false // Always draw
scene.add(trailMesh)

function resetTrail(i: number, x: number, y: number, z: number) {
  // Fill entire ring buffer with current pos to "collapse" the trail
  for (let k = 0; k < MAX_TRAIL_LENGTH; k++) {
    const idx = (i * MAX_TRAIL_LENGTH + k) * 3
    trailHistory[idx] = x
    trailHistory[idx + 1] = y
    trailHistory[idx + 2] = z
  }
}


// --- Pheromone System ---
const PHEROMONE_SIZE = 1024
const pheromoneCanvas = document.createElement('canvas')
pheromoneCanvas.width = PHEROMONE_SIZE
pheromoneCanvas.height = PHEROMONE_SIZE
const pheromoneCtx = pheromoneCanvas.getContext('2d')!
pheromoneCtx.fillStyle = '#000000'
pheromoneCtx.fillRect(0, 0, PHEROMONE_SIZE, PHEROMONE_SIZE)

const pheromoneTexture = new THREE.CanvasTexture(pheromoneCanvas)
pheromoneTexture.minFilter = THREE.LinearFilter
pheromoneTexture.magFilter = THREE.LinearFilter // Smooth look

const pheromoneGeometry = new THREE.PlaneGeometry(24, 24) // Covers approx platform + buffer
const pheromoneMaterial = new THREE.MeshBasicMaterial({
  map: pheromoneTexture,
  transparent: true,
  opacity: 0.8,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  side: THREE.DoubleSide
})
const pheromoneMesh = new THREE.Mesh(pheromoneGeometry, pheromoneMaterial)
pheromoneMesh.rotation.x = -Math.PI / 2
pheromoneMesh.position.y = 0.015 // Slightly above grid
scene.add(pheromoneMesh)

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000)
camera.position.set(0, 2.0, 4.5)
camera.lookAt(0, 0, 0)

const renderer = new THREE.WebGLRenderer({ canvas, antialias: false })
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.toneMapping = THREE.ReinhardToneMapping
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap

// --- Post Processing ---
const renderScene = new RenderPass(scene, camera)
const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.5, 0.4, 0.85)
bloomPass.threshold = config.bloomThreshold
bloomPass.strength = config.bloomStrength
bloomPass.radius = config.bloomRadius

// Depth of Field (Visual improvement #7)
const bokehPass = new BokehPass(scene, camera, {
  focus: config.dofFocus,
  aperture: config.dofAperture,
  maxblur: 0.01
})
bokehPass.enabled = config.enableDOF

const composer = new EffectComposer(renderer)
composer.addPass(renderScene)
composer.addPass(bloomPass)
composer.addPass(bokehPass)

// --- Controls ---
const controls = new OrbitControls(camera, canvas)
controls.enableDamping = true
controls.maxPolarAngle = Math.PI / 2 - 0.1

// --- Interact / Raycasting ---
// raycaster, pointer, etc already defined above
const planeGeometry = new THREE.PlaneGeometry(100, 100)
const plane = new THREE.Mesh(planeGeometry, new THREE.MeshBasicMaterial({ visible: false }))
plane.rotation.x = -Math.PI / 2
plane.position.y = 0.5
scene.add(plane)

// Tracks circular obstacles
let draggedCircleIndex = -1

window.addEventListener('pointerdown', (event) => {
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1

  raycaster.setFromCamera(mouse, camera)

  const intersects = raycaster.intersectObjects(obstacleMeshes)

  if (intersects.length > 0) {
    const hit = intersects[0]
    const idx = obstacleMeshes.indexOf(hit.object as THREE.Mesh)

    if (idx !== -1) {
      dragMode = 'MOVE'
      draggedCircleIndex = idx
      controls.enabled = false

      // Offset
      const groundInt = raycaster.intersectObject(plane)
      if (groundInt.length > 0) {
        dragOffset.copy(hit.object.position).sub(groundInt[0].point)
      }
    }
  }
})

window.addEventListener('pointermove', (event) => {
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1

  if (dragMode !== 'NONE' && draggedCircleIndex !== -1) {
    raycaster.setFromCamera(mouse, camera)
    const intersects = raycaster.intersectObject(plane)

    if (intersects.length > 0) {
      const pt = intersects[0].point
      const newPos = pt.clone().add(dragOffset)

      // Update Mesh
      const mesh = obstacleMeshes[draggedCircleIndex]
      mesh.position.set(newPos.x, 0, newPos.z)

      // Update Data
      obstacleData[draggedCircleIndex * 3 + 0] = newPos.x
      obstacleData[draggedCircleIndex * 3 + 1] = newPos.z
    }
  }
})

window.addEventListener('pointerup', () => {
  if (dragMode !== 'NONE') {
    controls.enabled = true
    dragMode = 'NONE'
    draggedCircleIndex = -1
  }
})

// --- Stats ---
const fpsDiv = document.createElement('div')
fpsDiv.style.position = 'absolute'
fpsDiv.style.bottom = '10px'
fpsDiv.style.left = '10px'
fpsDiv.style.color = '#888'
fpsDiv.style.fontFamily = 'monospace'
fpsDiv.style.fontSize = '12px'
fpsDiv.style.pointerEvents = 'none'
fpsDiv.innerText = 'FPS: 0'
document.body.appendChild(fpsDiv)

let lastTime = performance.now()
let frames = 0
let lastFpsUpdate = lastTime

// --- Lighting ---
const hemiLight = new THREE.HemisphereLight(0xffeeb1, 0x080820, 0.5)
scene.add(hemiLight)

const dirLight = new THREE.DirectionalLight(0xffffff, 1.5)
dirLight.position.set(10, 20, 10)
dirLight.castShadow = true
dirLight.shadow.mapSize.width = 2048
dirLight.shadow.mapSize.height = 2048
dirLight.shadow.camera.near = 0.1
dirLight.shadow.camera.far = 50
dirLight.shadow.camera.left = -15
dirLight.shadow.camera.right = 15
dirLight.shadow.camera.top = 15
dirLight.shadow.camera.bottom = -15
dirLight.shadow.bias = -0.0005
scene.add(dirLight)

const poleLight = new THREE.PointLight(config.poleColor, 5, 20)
poleLight.position.set(0, 3, 0)
poleLight.castShadow = false
scene.add(poleLight)

// --- Objects ---
const platformGeometry = new THREE.CylinderGeometry(config.platformRadius, config.platformRadius, 0.5, 64)
const platformMaterial = new THREE.MeshStandardMaterial({
  color: config.platformColor,
  roughness: 0.8,
  metalness: 0.2,
  envMapIntensity: 0.5
})
const platform = new THREE.Mesh(platformGeometry, platformMaterial)
platform.position.y = -0.25
platform.receiveShadow = true
scene.add(platform)

// Minor gridlines - dense and subtle
const minorGrid = new THREE.PolarGridHelper(config.platformRadius, 32, 10, 64, 0x333333, 0x222222)
minorGrid.position.y = 0.01
scene.add(minorGrid)

// Major gridlines - less dense and brighter
const majorGrid = new THREE.PolarGridHelper(config.platformRadius, 8, 4, 64, 0x555555, 0x333333)
majorGrid.position.y = 0.02
scene.add(majorGrid)

const ringGeo = new THREE.RingGeometry(config.poleRadius + 0.1, config.poleRadius + 0.5, 32)
ringGeo.rotateX(-Math.PI / 2)
const ringMat = new THREE.MeshBasicMaterial({ color: config.poleColor, transparent: true, opacity: 0.5, side: THREE.DoubleSide })
const ring = new THREE.Mesh(ringGeo, ringMat)
ring.position.y = 0.01
scene.add(ring)

const poleShape = new THREE.Shape()
poleShape.absarc(0, 0, config.poleRadius - 0.1, 0, Math.PI * 2, false)

const poleGeometry = new THREE.ExtrudeGeometry(poleShape, {
  depth: config.poleHeight - 0.2,
  bevelEnabled: true,
  bevelSegments: 10,
  bevelSize: 0.1,
  bevelThickness: 0.1,
  curveSegments: 32
})

const poleMaterial = new THREE.MeshStandardMaterial({
  color: config.poleColor,
  emissive: config.poleColor,
  emissiveIntensity: 0.5,
  transparent: true,
  opacity: config.poleOpacity,
  roughness: 0.2,
  metalness: 0.5,
  side: THREE.DoubleSide,
  shadowSide: THREE.DoubleSide
})
const pole = new THREE.Mesh(poleGeometry, poleMaterial)
pole.rotation.x = -Math.PI / 2
poleGeometry.center()
pole.position.y = (config.poleHeight / 2) - 0.02
pole.castShadow = true
pole.receiveShadow = true
scene.add(pole)

// Energy rings removed - were distracting

// --- Pole Enhancement: Spark particles for when particles touch ---
const SPARK_COUNT = 50
const sparkGeometry = new THREE.BufferGeometry()
const sparkPositions = new Float32Array(SPARK_COUNT * 3)
const sparkVelocities = new Float32Array(SPARK_COUNT * 3)
const sparkLifetimes = new Float32Array(SPARK_COUNT)
const sparkColors = new Float32Array(SPARK_COUNT * 3)

for (let i = 0; i < SPARK_COUNT; i++) {
  sparkPositions[i * 3] = 99999  // Off-screen initially
  sparkPositions[i * 3 + 1] = 99999
  sparkPositions[i * 3 + 2] = 99999
  sparkLifetimes[i] = 0
}

sparkGeometry.setAttribute('position', new THREE.BufferAttribute(sparkPositions, 3))
sparkGeometry.setAttribute('color', new THREE.BufferAttribute(sparkColors, 3))

const sparkMaterial = new THREE.PointsMaterial({
  size: 0.08,
  vertexColors: true,
  transparent: true,
  opacity: 0.9,
  blending: THREE.AdditiveBlending,
  depthWrite: false
})

const sparkMesh = new THREE.Points(sparkGeometry, sparkMaterial)
scene.add(sparkMesh)

let nextSparkIndex = 0

function emitSpark(x: number, z: number) {
  const idx = nextSparkIndex
  nextSparkIndex = (nextSparkIndex + 1) % SPARK_COUNT

  sparkPositions[idx * 3] = x
  sparkPositions[idx * 3 + 1] = 0.3 + Math.random() * 0.2
  sparkPositions[idx * 3 + 2] = z

  // Random upward/outward velocity
  const angle = Math.atan2(z, x) + (Math.random() - 0.5) * 1.5
  const speed = 0.02 + Math.random() * 0.03
  sparkVelocities[idx * 3] = Math.cos(angle) * speed
  sparkVelocities[idx * 3 + 1] = 0.03 + Math.random() * 0.02
  sparkVelocities[idx * 3 + 2] = Math.sin(angle) * speed

  sparkLifetimes[idx] = 1.0

  // Color from pole color
  const c = new THREE.Color(config.poleColor)
  sparkColors[idx * 3] = c.r
  sparkColors[idx * 3 + 1] = c.g
  sparkColors[idx * 3 + 2] = c.b
}

function updateSparks(dt: number) {
  for (let i = 0; i < SPARK_COUNT; i++) {
    if (sparkLifetimes[i] > 0) {
      sparkLifetimes[i] -= dt * 2

      // Update position
      sparkPositions[i * 3] += sparkVelocities[i * 3]
      sparkPositions[i * 3 + 1] += sparkVelocities[i * 3 + 1]
      sparkPositions[i * 3 + 2] += sparkVelocities[i * 3 + 2]

      // Gravity
      sparkVelocities[i * 3 + 1] -= 0.002

      // Fade color
      const fade = sparkLifetimes[i]
      sparkColors[i * 3] *= 0.98
      sparkColors[i * 3 + 1] *= 0.95
      // Keep blue channel for trail effect

      if (sparkLifetimes[i] <= 0) {
        sparkPositions[i * 3] = 99999
        sparkPositions[i * 3 + 1] = 99999
        sparkPositions[i * 3 + 2] = 99999
      }
    }
  }
  sparkGeometry.attributes.position.needsUpdate = true
  sparkGeometry.attributes.color.needsUpdate = true
}

// --- Composite Particle Geometry (Capsule Body + Head Shell) ---
const bodyGeometry = new THREE.CapsuleGeometry(0.03, 0.12, 4, 8)
const headGeometry = new THREE.SphereGeometry(0.031, 8, 8)

const bodyMaterial = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  roughness: 0.9,
  metalness: 0.1
})

const headMaterial = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  roughness: 0.9,
  metalness: 0.1
})

const bodyMesh = new THREE.InstancedMesh(bodyGeometry, bodyMaterial, MAX_PARTICLE_COUNT)
bodyMesh.castShadow = true
bodyMesh.receiveShadow = true
bodyMesh.count = config.particleCount
scene.add(bodyMesh)

const headMesh = new THREE.InstancedMesh(headGeometry, headMaterial, MAX_PARTICLE_COUNT)
headMesh.castShadow = true
headMesh.receiveShadow = true
headMesh.count = config.particleCount
scene.add(headMesh)

// --- Obstacles Generation (Beveled Pucks) ---
const obstacleShape = new THREE.Shape()
obstacleShape.absarc(0, 0, 1, 0, Math.PI * 2, false)

const obstacleGeometry = new THREE.ExtrudeGeometry(obstacleShape, {
  depth: 0.8,
  bevelEnabled: true,
  bevelSegments: 5,
  bevelSize: 0.1,
  bevelThickness: 0.1,
  curveSegments: 32
})

// Match Platform Material with Fancy Grid
const obstacleMaterial = new THREE.MeshStandardMaterial({
  color: config.obstacleColor,
  roughness: 0.8,
  metalness: 0.2,
  envMapIntensity: 0.5
})

obstacleMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.uTime = { value: 0 }

  // Pass world config if needed
  shader.fragmentShader = `
    varying vec3 vWorldPosition;
  ` + shader.fragmentShader

  shader.vertexShader = `
    varying vec3 vWorldPosition;
  ` + shader.vertexShader

  shader.vertexShader = shader.vertexShader.replace(
    '#include <worldpos_vertex>',
    `
    #include <worldpos_vertex>
    vWorldPosition = (modelMatrix * vec4( transformed, 1.0 )).xyz;
    `
  )

  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <dithering_fragment>',
    `
    #include <dithering_fragment>
    
    // Grid Logic
    float gridSize = 1.0; 
    float lineWidth = 0.05;
    
    // Use local or world pos. Let's use local X/Z relative to object center 
    // IF we are in local space. But here vWorldPosition is world.
    
    // Let's make a grid based on absolute world coords for a "holodeck" feel
    // Or local object coords if we want the grid to stick to the object.
    
    // Since objects rotate/scale, World Pos is cooler for a "projection" effect
    // But user asked for grid ON obstacles.
    
    // Simple Modulo Grid
    float gx = step(1.0 - lineWidth, fract(vWorldPosition.x * 2.0));
    float gz = step(1.0 - lineWidth, fract(vWorldPosition.z * 2.0));
    float grid = max(gx, gz);
    
    // Mix with base color
    vec3 gridColor = vec3(0.0, 0.8, 1.0) * 2.0; 
    
    if (grid > 0.5) {
        gl_FragColor.rgb = mix(gl_FragColor.rgb, gridColor, 0.5);
        gl_FragColor.rgb += gridColor * 0.2; 
    }
    `
  )
}

for (let i = 0; i < config.obstacleCount; i++) {
  const obs = new THREE.Mesh(obstacleGeometry, obstacleMaterial.clone())
  obs.castShadow = true
  obs.receiveShadow = true
  obs.rotation.x = -Math.PI / 2 // Lay flat
  scene.add(obs)
  obstacleMeshes.push(obs)

  // Random size
  let obsR = 0
  const isLarge = Math.random() > 0.8
  if (isLarge) {
    obsR = 0.8 + Math.random() * 0.4
  } else {
    obsR = 0.4 + Math.random() * 0.3
  }

  const obsHeight = 0.36

  // Position
  const distRangeMin = config.poleRadius + obsR + 0.2
  const distRangeMax = config.platformRadius - obsR - 0.2
  const angle = Math.random() * Math.PI * 2
  const r = Math.sqrt(Math.random() * (distRangeMax * distRangeMax - distRangeMin * distRangeMin) + distRangeMin * distRangeMin)
  const x = Math.cos(angle) * r
  const z = Math.sin(angle) * r

  obs.position.set(x, 0, z)
  obs.scale.set(obsR, obsR, obsHeight)

  obstacleData[i * 3] = x
  obstacleData[i * 3 + 1] = z
  obstacleData[i * 3 + 2] = obsR
}

// --- Logic Helpers ---
const dummy = new THREE.Object3D()
const _color = new THREE.Color()
const _targetColor = new THREE.Color()

// --- Group System: Black, White, Yellow ---
// Group IDs
const GROUP_BLACK = 0
const GROUP_WHITE = 1
const GROUP_YELLOW = 2

// Group Colors (distinct for clear visual only - no strength difference)
const groupColors = {
  [GROUP_BLACK]: 0x1a1a1a,   // Dark Black
  [GROUP_WHITE]: 0xf5f5f5,   // Off-White
  [GROUP_YELLOW]: 0xf5e6a3   // Pale Yellow / Cream
}

// Personal space multiplier per group (Physics improvement #3)
const groupPersonalSpace = {
  [GROUP_BLACK]: 0.7,    // Tight clusters
  [GROUP_WHITE]: 1.0,    // Moderate spacing
  [GROUP_YELLOW]: 1.4    // Prefers more space
}

// Attraction config - SECONDARY to pole-seeking behavior
const attractionConfig = {
  attractionRadius: 1.0565,
  attractionForce: 0.0135,
  groupAffinityBonus: 1.439,
  crossGroupAttraction: 0
}

const STATE_SEEKING = 0
const STATE_ORBITING = 1
const STATE_LEAVING = 2

function initParticle(i: number) {
  // Assign group: roughly equal distribution (visual only, no strength difference)
  const groupRoll = Math.random()
  let group: number
  if (groupRoll < 0.33) {
    group = GROUP_BLACK
  } else if (groupRoll < 0.66) {
    group = GROUP_WHITE
  } else {
    group = GROUP_YELLOW
  }

  // All particles have equal base properties
  const scale = 0.9 + Math.random() * 0.2
  const pRadius = 0.03 * scale * 1.5

  // Random Entrance (360 deg)
  const angle = Math.random() * Math.PI * 2
  const startRadius = config.platformRadius - 0.5

  const x = Math.cos(angle) * startRadius
  const z = Math.sin(angle) * startRadius

  // Traits - same for all groups
  const speedMult = 0.7 + Math.random() * 0.6
  const agilityMult = 0.5 + Math.random() * 1.0

  particles[i * STRIDE + OFFSET.X] = x
  particles[i * STRIDE + OFFSET.Z] = z

  // Rush Inwards
  const speed = (config.speed * 1.5) * speedMult
  particles[i * STRIDE + OFFSET.VX] = -Math.cos(angle) * speed
  particles[i * STRIDE + OFFSET.VZ] = -Math.sin(angle) * speed

  particles[i * STRIDE + OFFSET.RADIUS] = pRadius
  particles[i * STRIDE + OFFSET.SPEED_MULT] = speedMult
  particles[i * STRIDE + OFFSET.AGILITY] = agilityMult
  particles[i * STRIDE + OFFSET.STATE] = STATE_SEEKING
  particles[i * STRIDE + OFFSET.ACCUM_ANGLE] = 0

  // Reset Trail for this particle
  resetTrail(i, x, 0.09 * scale, z)

  // Set color based on group
  const colorHex = groupColors[group]
  particles[i * STRIDE + OFFSET.BASE_COLOR] = colorHex
  particles[i * STRIDE + OFFSET.GROUP] = group

  // New fields for physics/visual improvements
  particles[i * STRIDE + OFFSET.MASS] = 0.7 + Math.random() * 0.6  // Mass for momentum/inertia
  particles[i * STRIDE + OFFSET.PERSONAL_SPACE] = groupPersonalSpace[group]  // Group-based spacing
  particles[i * STRIDE + OFFSET.PHASE] = Math.random() * Math.PI * 2  // Phase for bobbing animation
  particles[i * STRIDE + OFFSET.ORBIT_LAYER] = -1  // Will be assigned when orbiting
  particles[i * STRIDE + OFFSET.COLOR_BLEND] = 0  // 0 = original color, 1 = fully red
  particles[i * STRIDE + OFFSET.WANDER_ANGLE] = Math.random() * Math.PI * 2  // For leaving behavior
  particles[i * STRIDE + OFFSET.LEAVING_TIME] = 0  // Time spent in LEAVING state

  // Set positions with initial rotation (facing inward)
  updateParticleMesh(i, x, z, scale, -Math.cos(angle), -Math.sin(angle))

  // Color: Applies to BOTH Body and Head initially
  _color.setHex(colorHex)
  headMesh.setColorAt(i, _color)
  bodyMesh.setColorAt(i, _color)
}

function updateParticleMesh(i: number, x: number, z: number, scale: number, vx: number = 0, vz: number = 0, bobOffset: number = 0, scaleMultiplier: number = 1.0) {
  // Calculate rotation to face movement direction (Visual improvement #1)
  const speed = Math.sqrt(vx * vx + vz * vz)
  let rotationY = 0
  if (speed > 0.001) {
    rotationY = Math.atan2(vx, vz)  // Face velocity direction
  }

  const finalScale = scale * scaleMultiplier

  // Body (Capsule) - pivot is center with bobbing offset
  dummy.position.set(x, 0.09 * finalScale + bobOffset, z)
  dummy.rotation.set(0, rotationY, 0)
  dummy.scale.set(finalScale, finalScale, finalScale)
  dummy.updateMatrix()
  bodyMesh.setMatrixAt(i, dummy.matrix)

  // Head (Sphere overlay) - Offset Y = 0.06 (half height of cylinder straight part)
  dummy.position.set(x, (0.09 + 0.06) * finalScale + bobOffset, z)
  dummy.rotation.set(0, rotationY, 0)
  dummy.scale.set(finalScale, finalScale, finalScale)
  dummy.updateMatrix()
  headMesh.setMatrixAt(i, dummy.matrix)
}

// Initial Spawn
for (let i = 0; i < config.particleCount; i++) {
  initParticle(i)
}
bodyMesh.instanceMatrix.needsUpdate = true
bodyMesh.instanceColor!.needsUpdate = true
headMesh.instanceMatrix.needsUpdate = true
headMesh.instanceColor!.needsUpdate = true

const maxDiameter = config.particleRadius * 1.5 * 2
const cellSize = maxDiameter * 1.2
const gridOffset = config.platformRadius

function updateGrid() {
  const dim = GRID_DIM
  gridHead.fill(-1, 0, dim * dim)

  for (let i = 0; i < config.particleCount; i++) {
    const x = particles[i * STRIDE + OFFSET.X]
    const z = particles[i * STRIDE + OFFSET.Z]

    if (isNaN(x) || isNaN(z)) continue;

    const col = Math.floor((x + gridOffset) / cellSize)
    const row = Math.floor((z + gridOffset) / cellSize)

    if (col >= 0 && col < dim && row >= 0 && row < dim) {
      const cellIndex = row * dim + col
      gridNext[i] = gridHead[cellIndex]
      gridHead[cellIndex] = i
    } else {
      gridNext[i] = -1
    }
  }
}

// --- GUI ---
const gui = new GUI({ title: 'Carousel Settings' })
const sceneFolder = gui.addFolder('Visuals')
sceneFolder.add(config, 'showTrails').name('Show Traces (Red)').onChange((v: boolean) => trailMesh.visible = v)
sceneFolder.add(config, 'showPheromones').name('Show Pheromones').onChange((v: boolean) => pheromoneMesh.visible = v)
sceneFolder.addColor(config, 'backgroundColor').onChange((c: string) => {
  scene.background = new THREE.Color(c)
  scene.fog = new THREE.FogExp2(c, 0.02)
})
sceneFolder.addColor(config, 'platformColor').name('Platform').onChange((c: string) => platformMaterial.color.set(c))
sceneFolder.addColor(config, 'obstacleColor').name('Obstacles').onChange((c: string) => {
  obstacleMeshes.forEach(mesh => {
    (mesh.material as THREE.MeshStandardMaterial).color.set(c)
  })
  obstacleMaterial.color.set(c)
})
sceneFolder.addColor(config, 'poleColor').name('Pole').onChange((c: string) => {
  poleMaterial.color.set(c)
  poleMaterial.emissive.set(c)
  poleLight.color.set(c)
  ringMat.color.set(c)
})
sceneFolder.add(config, 'poleOpacity', 0, 1).name('Pole Opacity').onChange((v: number) => {
  poleMaterial.opacity = v
})
sceneFolder.addColor(config, 'particleColor').name('Particles').onChange((c: string) => {
  headMaterial.color.set(c)
  bodyMaterial.color.set(c)
})
sceneFolder.add(config, 'bloomStrength', 0, 0.2).onChange((v: number) => bloomPass.strength = v)
sceneFolder.add(config, 'bloomRadius', 0, 1).onChange((v: number) => bloomPass.radius = v)

const physicsFolder = gui.addFolder('Physics')
physicsFolder.add(config, 'speed', 0, 1)
physicsFolder.add(config, 'separationForce', 0, 4)
physicsFolder.add(config, 'centrifugalForce', -0.3, 0.1).name('Centrifugal Force')
physicsFolder.add(config, 'vortexStrength', 0, 2).name('Vortex Strength')
physicsFolder.add(config, 'particleCount').name('Active Count').listen().disable()

// Group Attraction Controls (secondary to pole-seeking)
const groupFolder = gui.addFolder('Group Behavior')
groupFolder.add(attractionConfig, 'attractionForce', 0, 0.02).name('Attraction (subtle)')
groupFolder.add(attractionConfig, 'attractionRadius', 0.5, 4).name('Attraction Range')
groupFolder.add(attractionConfig, 'groupAffinityBonus', 0.5, 2).name('Same-Group Bond')
groupFolder.add(attractionConfig, 'crossGroupAttraction', 0, 2).name('Cross-Group Pull')

// New Visual Controls
const visualFolder = gui.addFolder('Visual Effects')
visualFolder.add(config, 'enableBobbing').name('Walking Bobbing')
visualFolder.add(config, 'bobbingIntensity', 0, 0.03).name('Bob Intensity')
visualFolder.add(config, 'enableDOF').name('Depth of Field').onChange((v: boolean) => bokehPass.enabled = v)
visualFolder.add(config, 'dofFocus', 1, 15).name('DOF Focus').onChange((v: number) => {
  (bokehPass.uniforms as any)['focus'].value = v
})
visualFolder.add(config, 'dofAperture', 0, 0.01).name('DOF Aperture').onChange((v: number) => {
  (bokehPass.uniforms as any)['aperture'].value = v
})

// New Physics Controls
const advPhysicsFolder = gui.addFolder('Advanced Physics')
advPhysicsFolder.add(config, 'densitySlowdown', 0, 0.2).name('Density Slowdown')
advPhysicsFolder.add(config, 'alignmentForce', 0, 0.1).name('Lane Alignment')
advPhysicsFolder.add(config, 'anticipationDistance', 0, 1.5).name('Avoidance Lookahead')
advPhysicsFolder.add(config, 'turbulenceStrength', 0, 0.01).name('Turbulence')
advPhysicsFolder.add(config, 'orbitLayers', 1, 8, 1).name('Orbit Layers')

// Debug Mode Logic
const debugLabels: THREE.Sprite[] = []
const labelTextureCache: { [key: number]: THREE.Texture } = {}

function getTextureForNumber(n: number) {
  if (labelTextureCache[n]) return labelTextureCache[n]

  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = 'white'
  ctx.font = 'bold 48px Arial'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(n.toString(), 32, 32)

  const tex = new THREE.CanvasTexture(canvas)
  labelTextureCache[n] = tex
  return tex
}

function updateDebugMode() {
  if (config.debugMode) {
    // RESET to 100 particles
    config.particleCount = 100
    // Reinforce limits
    for (let i = 100; i < MAX_PARTICLE_COUNT; i++) {
      // Reset state for unused particles just in case
      particles[i * STRIDE + OFFSET.STATE] = STATE_SEEKING
    }
  } else {
    // Clear labels
    debugLabels.forEach(l => scene.remove(l))
    debugLabels.length = 0
  }
}

gui.add(config, 'debugMode').name('Debug Mode (100 Ppl)').onChange(updateDebugMode)

// Reset button - clear all and start from scratch
const resetSimulation = () => {
  // Reset particle count to zero
  config.particleCount = 0
  bodyMesh.count = 0
  headMesh.count = 0
  
  // Clear all trail data
  for (let i = 0; i < trailHistory.length; i++) {
    trailHistory[i] = 99999
  }
  for (let i = 0; i < trailPositions.length; i++) {
    trailPositions[i] = 99999
  }
  trailHeads.fill(0)
  
  // Clear debug labels
  debugLabels.forEach(label => {
    if (label) label.visible = false
  })
  
  bodyMesh.instanceMatrix.needsUpdate = true
  headMesh.instanceMatrix.needsUpdate = true
}
gui.add({ reset: resetSimulation }, 'reset').name('Reset (Clear All)')

// Restart button - keep existing people but send them back to edge
const restartSimulation = () => {
  const currentCount = config.particleCount
  
  // Reinitialize all existing particles (sends them back to edge)
  for (let i = 0; i < currentCount; i++) {
    initParticle(i)
  }
  
  // Clear trails
  for (let i = 0; i < trailHistory.length; i++) {
    trailHistory[i] = 99999
  }
  for (let i = 0; i < trailPositions.length; i++) {
    trailPositions[i] = 99999
  }
  trailHeads.fill(0)
  
  // Clear debug labels
  debugLabels.forEach(label => {
    if (label) label.visible = false
  })
  
  bodyMesh.instanceMatrix.needsUpdate = true
  bodyMesh.instanceColor!.needsUpdate = true
  headMesh.instanceMatrix.needsUpdate = true
  headMesh.instanceColor!.needsUpdate = true
}
gui.add({ restart: restartSimulation }, 'restart').name('Restart (Keep People)')

gui.domElement.style.display = 'none'

const cogButton = document.createElement('button')
cogButton.innerText = '⚙️'
cogButton.style.position = 'absolute'
cogButton.style.top = '10px'
cogButton.style.right = '10px'
cogButton.style.zIndex = '1000'
cogButton.style.background = 'none'
cogButton.style.border = 'none'
cogButton.style.fontSize = '24px'
cogButton.style.cursor = 'pointer'
cogButton.style.opacity = '0.7'
cogButton.style.transition = 'opacity 0.2s'
cogButton.onmouseenter = () => cogButton.style.opacity = '1.0'
cogButton.onmouseleave = () => cogButton.style.opacity = '0.7'
cogButton.onclick = () => {
  const isHidden = gui.domElement.style.display === 'none'
  gui.domElement.style.display = isHidden ? 'block' : 'none'
}
document.body.appendChild(cogButton)

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
  composer.setSize(window.innerWidth, window.innerHeight)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
})

// --- Animation Loop ---
const TARGET_POPULATION = 15000

// Track orbit layer assignments for concentric ring effect
const orbitLayerCounts = new Int32Array(10) // Max 10 layers

// Color interpolation helpers
const _baseColor = new THREE.Color()
const _orangeColor = new THREE.Color(0xff6600)
const _redColor = new THREE.Color(0xff0000)

function animate() {
  const now = performance.now()
  const globalTime = now * 0.001 // Seconds for animations
  frames++
  if (now - lastFpsUpdate >= 500) {
    const fps = Math.round((frames * 1000) / (now - lastFpsUpdate))
    fpsDiv.innerText = 'FPS: ' + fps + ' | Count: ' + config.particleCount
    lastFpsUpdate = now
    frames = 0
  }

  // Continuous Spawning
  if (config.particleCount < TARGET_POPULATION) {
    const spawnRate = 2
    const startIdx = config.particleCount
    const endIdx = Math.min(startIdx + spawnRate, TARGET_POPULATION)

    if (!config.debugMode || config.particleCount < 100) {
      for (let i = startIdx; i < endIdx; i++) {
        if (config.debugMode && i >= 100) break;
        initParticle(i)
      }
      if (config.debugMode) {
        config.particleCount = Math.min(config.particleCount + spawnRate, 100)
      } else {
        config.particleCount = endIdx
      }
    }

    bodyMesh.count = config.particleCount
    headMesh.count = config.particleCount
    bodyMesh.instanceMatrix.needsUpdate = true
    bodyMesh.instanceColor!.needsUpdate = true
    headMesh.instanceMatrix.needsUpdate = true
    headMesh.instanceColor!.needsUpdate = true
  }

  controls.update()
  updateGrid()

  const dt = 0.016
  const dim = GRID_DIM

  // Energy rings animation removed

  // Update pole light pulsing based on orbit activity
  let orbitingCount = 0
  for (let i = 0; i < config.particleCount; i++) {
    if (particles[i * STRIDE + OFFSET.STATE] === STATE_ORBITING) orbitingCount++
  }
  const pulseIntensity = 5 + Math.sin(globalTime * 3) * 2 + orbitingCount * 0.01
  poleLight.intensity = Math.min(pulseIntensity, 15)

  // Update sparks
  updateSparks(dt)

  _targetColor.set(config.poleColor)

  for (let i = 0; i < config.particleCount; i++) {
    // Current State using OFFSET constants
    let x = particles[i * STRIDE + OFFSET.X]
    let z = particles[i * STRIDE + OFFSET.Z]
    let vx = particles[i * STRIDE + OFFSET.VX]
    let vz = particles[i * STRIDE + OFFSET.VZ]
    let r1 = particles[i * STRIDE + OFFSET.RADIUS]
    const mySpeedMult = particles[i * STRIDE + OFFSET.SPEED_MULT]
    const myAgilityMult = particles[i * STRIDE + OFFSET.AGILITY]
    let state = particles[i * STRIDE + OFFSET.STATE]
    const myMass = particles[i * STRIDE + OFFSET.MASS]
    const myPersonalSpace = particles[i * STRIDE + OFFSET.PERSONAL_SPACE]
    const myPhase = particles[i * STRIDE + OFFSET.PHASE]
    let colorBlend = particles[i * STRIDE + OFFSET.COLOR_BLEND]
    let wanderAngle = particles[i * STRIDE + OFFSET.WANDER_ANGLE]

    const minR = config.poleRadius + r1
    const maxR = config.platformRadius - r1

    // 1. Neighbor Physics with improved features
    let sepX = 0
    let sepZ = 0
    let attrX = 0
    let attrZ = 0
    let localDensity = 0
    
    // Lane alignment: track average velocity of nearby same-direction particles
    let alignVx = 0
    let alignVz = 0
    let alignCount = 0

    const col = Math.floor((x + gridOffset) / cellSize)
    const row = Math.floor((z + gridOffset) / cellSize)

    // Personal space affects soft threshold (Physics improvement #3)
    const softThresholdFactor = 1.2 * myPersonalSpace
    const myGroup = particles[i * STRIDE + OFFSET.GROUP]

    const dist = Math.sqrt(x * x + z * z)
    const toPoleX = -x / (dist + 0.001)
    const toPoleZ = -z / (dist + 0.001)

    // Check neighbors 3x3
    for (let r = row - 1; r <= row + 1; r++) {
      for (let c = col - 1; c <= col + 1; c++) {
        if (r >= 0 && r < dim && c >= 0 && c < dim) {
          const cellIndex = r * dim + c
          let j = gridHead[cellIndex]

          while (j !== -1) {
            if (i !== j) {
              const jx = particles[j * STRIDE + OFFSET.X]
              const jz = particles[j * STRIDE + OFFSET.Z]
              const jvx = particles[j * STRIDE + OFFSET.VX]
              const jvz = particles[j * STRIDE + OFFSET.VZ]
              const r2 = particles[j * STRIDE + OFFSET.RADIUS]
              const otherGroup = particles[j * STRIDE + OFFSET.GROUP]
              const otherPersonalSpace = particles[j * STRIDE + OFFSET.PERSONAL_SPACE]
              const otherState = particles[j * STRIDE + OFFSET.STATE]

              const dx = x - jx
              const dz = z - jz
              const dSq = dx * dx + dz * dz

              const combinedRadius = r1 + r2
              // Average personal space for combined soft radius
              const avgPersonalSpace = (myPersonalSpace + otherPersonalSpace) * 0.5
              const softRadius = combinedRadius * 1.2 * avgPersonalSpace

              // If we are LEAVING, we ignore crowd physics entirely (ghost through)
              if (state === STATE_LEAVING) {
                j = gridNext[j]
                continue
              }

              // --- ANTICIPATORY AVOIDANCE (Physics improvement #4) ---
              if (config.anticipationDistance > 0) {
                const futureX = x + vx * config.anticipationDistance * 10
                const futureZ = z + vz * config.anticipationDistance * 10
                const futureJX = jx + jvx * config.anticipationDistance * 10
                const futureJZ = jz + jvz * config.anticipationDistance * 10
                const futureDx = futureX - futureJX
                const futureDz = futureZ - futureJZ
                const futureDSq = futureDx * futureDx + futureDz * futureDz
                
                if (futureDSq < softRadius * softRadius && futureDSq > 0.01) {
                  const futureD = Math.sqrt(futureDSq)
                  const avoidForce = (softRadius - futureD) / futureD * 0.3
                  sepX += (futureDx / futureD) * avoidForce
                  sepZ += (futureDz / futureD) * avoidForce
                }
              }

              // --- LANE ALIGNMENT (Physics improvement #2) ---
              // Only align with particles moving in similar direction
              if (dSq < attractionConfig.attractionRadius * attractionConfig.attractionRadius) {
                const mySpeed = Math.sqrt(vx * vx + vz * vz)
                const otherSpeed = Math.sqrt(jvx * jvx + jvz * jvz)
                if (mySpeed > 0.01 && otherSpeed > 0.01) {
                  const dotVel = (vx * jvx + vz * jvz) / (mySpeed * otherSpeed)
                  if (dotVel > 0.5) { // Similar direction
                    alignVx += jvx
                    alignVz += jvz
                    alignCount++
                  }
                }
              }

              // --- ATTRACTION FORCE ---
              const attrRadiusSq = attractionConfig.attractionRadius * attractionConfig.attractionRadius
              if (dSq > softRadius * softRadius && dSq < attrRadiusSq) {
                const invD = 1.0 / Math.sqrt(dSq)
                const nx = dx * invD
                const nz = dz * invD
                const dotWithPole = -nx * toPoleX + -nz * toPoleZ

                if (dotWithPole > -0.3) {
                  const affinityMult = (myGroup === otherGroup) 
                    ? attractionConfig.groupAffinityBonus 
                    : attractionConfig.crossGroupAttraction
                  const poleAlignBonus = (dotWithPole + 0.3) * 0.77
                  const distFactor = 1.0 - Math.sqrt(dSq) * (1.0 / attractionConfig.attractionRadius)
                  const attrForce = attractionConfig.attractionForce * affinityMult * distFactor * poleAlignBonus
                  attrX -= nx * attrForce
                  attrZ -= nz * attrForce
                }
              }

              // Density check
              if (dSq < softRadius * softRadius * 1.5) {
                localDensity++
              }

              // --- COLLISION ---
              const isLeaving = (state === STATE_LEAVING)
              const otherIsLeaving = (otherState === STATE_LEAVING)
              
              // Leaving particles reduce collision response as urgency increases
              let collisionMult = 1.0
              if (isLeaving) {
                const myLeavingTime = particles[i * STRIDE + OFFSET.LEAVING_TIME]
                const urgencyPhase = myLeavingTime / 4.0
                // Collision reduction scales with urgency: 1.0 -> 0.4 -> 0.2
                collisionMult = Math.max(0.2, 1.0 - urgencyPhase * 0.4)
              }

              // Seekers yield to leavers to prevent crowd-lock
              if (!isLeaving && otherIsLeaving && dSq < softRadius * softRadius * 2) {
                const d = Math.sqrt(dSq)
                const avoidNx = dx / d
                const avoidNz = dz / d
                sepX += avoidNx * 0.4
                sepZ += avoidNz * 0.4
              }
              
              if (dSq > 0 && dSq < softRadius * softRadius) {
                const d = Math.sqrt(dSq)
                const nx = dx / d
                const nz = dz / d

                if (d < combinedRadius) {
                  const overlap = combinedRadius - d
                  const push = overlap * 0.45 * collisionMult
                  const pushMult = (state === STATE_ORBITING) ? 0.15 : 0.4
                  x += nx * push * pushMult
                  z += nz * push * pushMult
                }

                const force = (softRadius - d) / d * collisionMult
                sepX += nx * force * 0.8
                sepZ += nz * force * 0.8
              }
            }
            j = gridNext[j]
          }
        }
      }
    }

    // --- DENSITY SLOWDOWN (Physics improvement #1) ---
    const densityFactor = Math.max(0.3, 1.0 - localDensity * config.densitySlowdown)

    // --- TURBULENCE/NOISE (Physics improvement #7) ---
    let turbX = 0
    let turbZ = 0
    if (config.turbulenceStrength > 0) {
      turbX = noise2D(x * 0.3 + globalTime * 0.5, z * 0.3) * config.turbulenceStrength
      turbZ = noise2D(x * 0.3, z * 0.3 + globalTime * 0.5) * config.turbulenceStrength
    }

    // Apply forces with mass-based inertia (Physics improvement #5)
    const massInertia = 1.0 / myMass

    if (state !== STATE_ORBITING && state !== STATE_LEAVING) {
      vx += sepX * config.separationForce * 0.05 * massInertia
      vz += sepZ * config.separationForce * 0.05 * massInertia
      
      const poleProximityFactor = Math.min(1.0, (dist - config.poleRadius) / 3.0)
      vx += attrX * poleProximityFactor * massInertia
      vz += attrZ * poleProximityFactor * massInertia

      // Apply lane alignment (Physics improvement #2)
      if (alignCount > 0 && config.alignmentForce > 0) {
        alignVx /= alignCount
        alignVz /= alignCount
        vx += (alignVx - vx) * config.alignmentForce * massInertia
        vz += (alignVz - vz) * config.alignmentForce * massInertia
      }

      // Apply turbulence
      vx += turbX * massInertia
      vz += turbZ * massInertia
    }

    // --- State Logic ---
    if (state === STATE_SEEKING) {
      const rx = -x / dist
      const rz = -z / dist
      const tx = -z / dist
      const tz = x / dist

      let spiralDesire = 0.0
      if (dist < 1.2) spiralDesire = 1.0
      if (localDensity > 2) spiralDesire = Math.max(spiralDesire, Math.min(1.0, (localDensity - 2) * 0.3))

      let dx = tx * spiralDesire + rx * (1.0 - spiralDesire * 0.5)
      let dz = tz * spiralDesire + rz * (1.0 - spiralDesire * 0.5)

      const len = Math.sqrt(dx * dx + dz * dz)
      if (len > 0) { dx /= len; dz /= len; }

      let speedFactor = densityFactor // Apply density slowdown
      if (dist > 0.1 && dist < 5.0) {
        speedFactor *= 1.0 + config.vortexStrength * (5.0 / dist - 1.0)
        const proximityExcitement = Math.max(0, 1.0 - (dist - config.poleRadius) / 5.0)
        speedFactor *= (1.0 + proximityExcitement * 0.8)
        speedFactor = Math.max(0.1, Math.min(speedFactor, 4.0))
      }

      const currentSpeed = config.speed * speedFactor * mySpeedMult
      const desiredVx = dx * currentSpeed
      const desiredVz = dz * currentSpeed

      const proximityExcitement = Math.max(0, 1.0 - (dist - config.poleRadius) / 3.0)
      const dynamicAgility = myAgilityMult * (1.0 + proximityExcitement * 2.0)

      // Steering with mass-based inertia
      let steeringX = desiredVx - vx
      let steeringZ = desiredVz - vz
      const maxSteer = 0.05 * dynamicAgility * massInertia

      const steerLen = Math.sqrt(steeringX * steeringX + steeringZ * steeringZ)
      if (steerLen > maxSteer) {
        steeringX = (steeringX / steerLen) * maxSteer
        steeringZ = (steeringZ / steerLen) * maxSteer
      }

      vx += steeringX * 0.8
      vz += steeringZ * 0.8

      if (dist > 0.001) {
        vx -= (x / dist) * config.centrifugalForce * 0.05
        vz -= (z / dist) * config.centrifugalForce * 0.05
      }

      // Touch Check - start orbiting and assign layer
      if (dist < config.poleRadius + r1) {
        state = STATE_ORBITING
        particles[i * STRIDE + OFFSET.STATE] = STATE_ORBITING
        particles[i * STRIDE + OFFSET.ACCUM_ANGLE] = 0
        
        // Assign orbit layer (Physics improvement #6)
        let assignedLayer = 0
        const layerSpacing = r1 * 2.5
        for (let layer = 0; layer < config.orbitLayers; layer++) {
          if (orbitLayerCounts[layer] < (layer + 1) * 15) { // More particles in outer layers
            assignedLayer = layer
            orbitLayerCounts[layer]++
            break
          }
        }
        particles[i * STRIDE + OFFSET.ORBIT_LAYER] = assignedLayer
        const orbitRadius = config.poleRadius + r1 + assignedLayer * layerSpacing
        particles[i * STRIDE + OFFSET.ORBIT_RADIUS] = orbitRadius

        const orbitSpeed = config.speed
        const tangX = -z / dist
        const tangZ = x / dist
        vx = tangX * orbitSpeed
        vz = tangZ * orbitSpeed

        // Emit sparks when touching pole! (Visual improvement #6)
        for (let s = 0; s < 3; s++) {
          emitSpark(x, z)
        }
      }

      // Boundaries
      if (dist < minR) {
        const angle = Math.atan2(z, x)
        x = Math.cos(angle) * minR
        z = Math.sin(angle) * minR
      }

      if (dist > maxR) {
        const angle = Math.atan2(z, x)
        x = Math.cos(angle) * maxR
        z = Math.sin(angle) * maxR
        const rx = x / dist
        const rz = z / dist
        const vDotR = vx * rx + vz * rz
        if (vDotR > 0) {
          vx -= rx * vDotR
          vz -= rz * vDotR
          vx -= rx * 0.05
          vz -= rz * 0.05
        }
      } else if (dist > config.platformRadius * 0.9) {
        const rx = x / dist
        const rz = z / dist
        vx -= rx * 0.01
        vz -= rz * 0.01
      }

    } else if (state === STATE_ORBITING) {
      const orbitRadius = particles[i * STRIDE + OFFSET.ORBIT_RADIUS]
      const orbitSpeed = config.speed * 1.5

      const tx = -z / dist
      const tz = x / dist
      vx = tx * orbitSpeed
      vz = tz * orbitSpeed

      // Maintain orbit radius
      const rErr = orbitRadius - dist
      const rx = x / dist
      const rz = z / dist
      x += rx * rErr * 0.1
      z += rz * rErr * 0.1

      const angularVel = orbitSpeed / dist
      const dAngle = angularVel * dt

      let acc = particles[i * STRIDE + OFFSET.ACCUM_ANGLE]
      acc += dAngle
      particles[i * STRIDE + OFFSET.ACCUM_ANGLE] = acc

      // Gradual color transition (Visual improvement #2)
      // 0-1 orbit: base color, 1-2 orbits: blend to orange, 2-3 orbits: blend to red
      const orbits = acc / (Math.PI * 2)
      if (orbits < 1) {
        colorBlend = 0
      } else if (orbits < 2) {
        colorBlend = (orbits - 1) * 0.5 // 0 to 0.5 (orange)
      } else {
        colorBlend = 0.5 + (orbits - 2) * 0.5 // 0.5 to 1.0 (red)
      }
      colorBlend = Math.min(1.0, colorBlend)
      particles[i * STRIDE + OFFSET.COLOR_BLEND] = colorBlend

      if (acc > Math.PI * 2 * 3) {
        state = STATE_LEAVING
        particles[i * STRIDE + OFFSET.STATE] = STATE_LEAVING
        
        // Release orbit layer count
        const layer = particles[i * STRIDE + OFFSET.ORBIT_LAYER]
        if (layer >= 0 && layer < 10) orbitLayerCounts[layer]--
        
        // Initialize wander angle for leaving behavior
        wanderAngle = Math.atan2(z, x)
        particles[i * STRIDE + OFFSET.WANDER_ANGLE] = wanderAngle

        const rx = x / dist
        const rz = z / dist
        vx = rx * 0.03
        vz = rz * 0.03
      }

    } else if (state === STATE_LEAVING) {
      const acc = particles[i * STRIDE + OFFSET.ACCUM_ANGLE]
      if (acc < Math.PI * 2 * 3) {
        state = STATE_SEEKING
        particles[i * STRIDE + OFFSET.STATE] = STATE_SEEKING
        particles[i * STRIDE + OFFSET.ACCUM_ANGLE] = 0
        particles[i * STRIDE + OFFSET.COLOR_BLEND] = 0
        particles[i * STRIDE + OFFSET.LEAVING_TIME] = 0
      } else {
        // Track how long we've been trying to leave
        let leavingTime = particles[i * STRIDE + OFFSET.LEAVING_TIME]
        leavingTime += dt
        particles[i * STRIDE + OFFSET.LEAVING_TIME] = leavingTime

        // Safety timeout: force respawn if stuck too long
        const STUCK_TIMEOUT = 10.0
        if (leavingTime > STUCK_TIMEOUT) {
          initParticle(i)
          continue
        }

        // === URGENCY-BASED OUTWARD FORCE ===
        // Particle becomes increasingly determined to leave over time
        // Starts casual, becomes urgent, then desperate
        
        const urgencyPhase = leavingTime / 3.0  // 0-1 casual, 1-2 urgent, 2+ desperate
        
        // Urgency multiplier: 1.0 -> 1.5 -> 2.5 -> 4.0
        let urgency: number
        if (urgencyPhase < 1.0) {
          urgency = 1.0 + urgencyPhase * 0.6  // Casual: 1.0 to 1.6
        } else if (urgencyPhase < 2.0) {
          urgency = 1.6 + (urgencyPhase - 1.0) * 1.4  // Urgent: 1.6 to 3.0
        } else {
          urgency = 3.0 + (urgencyPhase - 2.0) * 1.6  // Desperate: 3.0+
        }
        urgency = Math.min(6.0, urgency)  // Cap at 6x

        // Outward direction
        const rx = x / (dist + 0.001)
        const rz = z / (dist + 0.001)

        // Wander decreases as urgency increases (more focused on leaving)
        const wanderAmount = Math.max(0.05, 0.35 - urgencyPhase * 0.15)
        wanderAngle += (Math.random() - 0.5) * wanderAmount
        particles[i * STRIDE + OFFSET.WANDER_ANGLE] = wanderAngle

        const wanderX = Math.cos(wanderAngle)
        const wanderZ = Math.sin(wanderAngle)

        // Outward bias increases with urgency (40% -> 90%)
        const outwardBias = Math.min(0.95, 0.5 + urgencyPhase * 0.25)
        const moveX = wanderX * (1 - outwardBias) + rx * outwardBias
        const moveZ = wanderZ * (1 - outwardBias) + rz * outwardBias

        // Base acceleration scaled by urgency
        const baseAccel = 0.008
        const accel = baseAccel * urgency
        vx += moveX * accel
        vz += moveZ * accel
        
        // Friction decreases with urgency (they push harder)
        const friction = Math.max(0.975, 0.992 - urgencyPhase * 0.006)
        vx *= friction
        vz *= friction

        // Extra outward push in dense crowds
        if (localDensity > 4) {
          const crowdBoost = Math.min(0.02, localDensity * 0.002)
          vx += rx * crowdBoost
          vz += rz * crowdBoost
        }

        // Fade color back gradually
        colorBlend = Math.max(0, colorBlend - dt * 0.25)
        particles[i * STRIDE + OFFSET.COLOR_BLEND] = colorBlend

        const currentDist = Math.sqrt(x * x + z * z)
        if (currentDist > config.platformRadius) {
          initParticle(i)
          continue
        }
      }
    }

    // Speed limit with density factor
    let speedLimit = config.speed * 1.5 * mySpeedMult * densityFactor
    if (state === STATE_LEAVING) {
      speedLimit = config.speed * 4.0 * mySpeedMult
    }
    const currentVel = Math.sqrt(vx * vx + vz * vz)
    if (currentVel > speedLimit) {
      vx = (vx / currentVel) * speedLimit
      vz = (vz / currentVel) * speedLimit
    }

    x += vx * dt
    z += vz * dt

    // Obstacle collision
    for (let k = 0; k < config.obstacleCount; k++) {
      const ox = obstacleData[k * 3]
      const oz = obstacleData[k * 3 + 1]
      const or = obstacleData[k * 3 + 2] * 1.15

      const dx = x - ox
      const dz = z - oz
      const dSq = dx * dx + dz * dz

      const minDist = r1 + or
      if (dSq < minDist * minDist) {
        const d = Math.sqrt(dSq)
        const pen = minDist - d
        const nx = dx / d
        const nz = dz / d

        const softPen = pen * 0.85
        x += nx * softPen
        z += nz * softPen

        const vDotN = vx * nx + vz * nz
        if (vDotN < 0) {
          vx -= nx * vDotN * 1.05
          vz -= nz * vDotN * 1.05
        }
      }
    }

    // Pole collision
    const dPoleSq = x * x + z * z
    const minPoleDist = config.poleRadius + r1
    if (dPoleSq < minPoleDist * minPoleDist) {
      const d = Math.sqrt(dPoleSq)
      if (d > 0.0001) {
        const nx = x / d
        const nz = z / d
        const pen = minPoleDist - d
        x += nx * pen * 0.9
        z += nz * pen * 0.9
        const vDotN = vx * nx + vz * nz
        if (vDotN < 0) {
          vx -= nx * vDotN
          vz -= nz * vDotN
        }
        vx += nx * 0.001
        vz += nz * 0.001
      } else {
        x = minPoleDist
        z = 0
      }
    }

    // Store updated values
    particles[i * STRIDE + OFFSET.X] = x
    particles[i * STRIDE + OFFSET.Z] = z
    particles[i * STRIDE + OFFSET.VX] = vx
    particles[i * STRIDE + OFFSET.VZ] = vz

    // Respawn check
    if (state !== STATE_LEAVING) {
      const currentDist = Math.sqrt(x * x + z * z)
      if (currentDist > config.platformRadius * 2.0 || isNaN(x) || isNaN(z)) {
        initParticle(i)
        continue
      }
    }

    // --- Visual Updates ---
    const baseColorHex = particles[i * STRIDE + OFFSET.BASE_COLOR]
    
    // Gradual color transition (Visual improvement #2)
    _baseColor.setHex(baseColorHex)
    if (colorBlend > 0) {
      if (colorBlend <= 0.5) {
        // Blend base -> orange
        _color.copy(_baseColor).lerp(_orangeColor, colorBlend * 2)
      } else {
        // Blend orange -> red
        _color.copy(_orangeColor).lerp(_redColor, (colorBlend - 0.5) * 2)
      }
    } else {
      _color.copy(_baseColor)
    }
    bodyMesh.setColorAt(i, _color)
    headMesh.setColorAt(i, _color)

    // Debug labels
    if (config.debugMode && (state === STATE_ORBITING || state === STATE_LEAVING)) {
      const turns = Math.floor(particles[i * STRIDE + OFFSET.ACCUM_ANGLE] / (Math.PI * 2))
      let label = debugLabels[i]
      if (!label) {
        const mat = new THREE.SpriteMaterial({ map: getTextureForNumber(0), depthTest: false, depthWrite: false })
        label = new THREE.Sprite(mat)
        label.scale.set(0.1, 0.1, 0.1)
        scene.add(label)
        debugLabels[i] = label
      }
      label.visible = true
      label.position.set(x, 0.25, z)
      if (label.userData.turns !== turns) {
        label.material.map = getTextureForNumber(turns)
        label.userData.turns = turns
      }
    } else if (debugLabels[i]) {
      debugLabels[i].visible = false
    }

    // --- Scale Variation by State (Visual improvement #4) ---
    let scaleMultiplier = 1.0
    if (state === STATE_SEEKING) {
      // Slight excitement near pole
      const proximityExcitement = Math.max(0, 1.0 - (dist - config.poleRadius) / 3.0)
      scaleMultiplier = 1.0 + proximityExcitement * 0.1
    } else if (state === STATE_ORBITING) {
      // Pulse/breathe effect while orbiting
      const breathe = Math.sin(globalTime * 4 + myPhase) * 0.05
      scaleMultiplier = 1.05 + breathe
    } else if (state === STATE_LEAVING) {
      // Shrink as they lose interest
      const shrinkProgress = Math.min(1.0, (dist - config.poleRadius) / (config.platformRadius - config.poleRadius))
      scaleMultiplier = 1.0 - shrinkProgress * 0.15
    }

    // --- Bobbing Animation (Visual improvement #3) ---
    let bobOffset = 0
    if (config.enableBobbing) {
      const speed = Math.sqrt(vx * vx + vz * vz)
      const bobFrequency = 8 + speed * 20
      bobOffset = Math.sin(globalTime * bobFrequency + myPhase) * config.bobbingIntensity * speed * 5
    }

    const normalizedScale = r1 / (0.03 * 1.5)
    updateParticleMesh(i, x, z, normalizedScale, vx, vz, bobOffset, scaleMultiplier)

    // --- Trail Update ---
    if (config.showTrails) {
      const isActive = (state === STATE_ORBITING || state === STATE_LEAVING)

      if (isActive) {
        const peekIdx = (i * MAX_TRAIL_LENGTH + trailHeads[i]) * 3
        const lastX = trailHistory[peekIdx]
        const lastZ = trailHistory[peekIdx + 2]
        const dSq = (x - lastX) * (x - lastX) + (z - lastZ) * (z - lastZ)

        if (dSq > 1.0 || lastX > 5000) {
          resetTrail(i, x, 0.1, z)
        }

        let head = trailHeads[i]
        head = (head + 1) % config.trailLength
        trailHeads[i] = head

        const hIdx = (i * MAX_TRAIL_LENGTH + head) * 3
        trailHistory[hIdx] = x
        trailHistory[hIdx + 1] = 0.1
        trailHistory[hIdx + 2] = z

        const vBase = i * SEGMENTS_PER_PARTICLE * 2 * 3

        for (let s = 0; s < config.trailLength - 1; s++) {
          let currRingIdx = (head - s)
          if (currRingIdx < 0) currRingIdx += config.trailLength

          let prevRingIdx = (head - s - 1)
          if (prevRingIdx < 0) prevRingIdx += config.trailLength

          const p1Idx = (i * MAX_TRAIL_LENGTH + currRingIdx) * 3
          const p2Idx = (i * MAX_TRAIL_LENGTH + prevRingIdx) * 3

          trailPositions[vBase + s * 6 + 0] = trailHistory[p1Idx]
          trailPositions[vBase + s * 6 + 1] = trailHistory[p1Idx + 1]
          trailPositions[vBase + s * 6 + 2] = trailHistory[p1Idx + 2]
          trailPositions[vBase + s * 6 + 3] = trailHistory[p2Idx]
          trailPositions[vBase + s * 6 + 4] = trailHistory[p2Idx + 1]
          trailPositions[vBase + s * 6 + 5] = trailHistory[p2Idx + 2]
        }
      } else {
        const vBase = i * SEGMENTS_PER_PARTICLE * 2 * 3
        if (trailPositions[vBase] < 5000) {
          for (let k = 0; k < SEGMENTS_PER_PARTICLE * 2 * 3; k++) {
            trailPositions[vBase + k] = 99999
          }
        }
      }
    }
  }

  if (config.showTrails) {
    trailMesh.visible = true
    trailGeometry.attributes.position.needsUpdate = true
  } else {
    trailMesh.visible = false
  }

  // Pheromone update
  if (config.showPheromones) {
    pheromoneMesh.visible = true
    pheromoneCtx.fillStyle = 'rgba(0, 0, 0, 0.05)'
    pheromoneCtx.fillRect(0, 0, PHEROMONE_SIZE, PHEROMONE_SIZE)
    pheromoneCtx.fillStyle = 'rgba(100, 200, 255, 0.5)'
    pheromoneCtx.beginPath()

    const mapRange = 24.0
    const halfMap = mapRange / 2.0
    let pointsDrawn = 0

    for (let i = 0; i < config.particleCount; i++) {
      const state = particles[i * STRIDE + OFFSET.STATE]
      if (state === STATE_ORBITING || state === STATE_LEAVING) {
        const x = particles[i * STRIDE + OFFSET.X]
        const z = particles[i * STRIDE + OFFSET.Z]
        const u = (x + halfMap) / mapRange
        const v = (z + halfMap) / mapRange
        if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
          const px = u * PHEROMONE_SIZE
          const py = v * PHEROMONE_SIZE
          pheromoneCtx.moveTo(px, py)
          pheromoneCtx.arc(px, py, 3, 0, Math.PI * 2)
          pointsDrawn++
        }
      }
    }
    if (pointsDrawn > 0) pheromoneCtx.fill()
    pheromoneTexture.needsUpdate = true
  } else {
    pheromoneMesh.visible = false
  }

  bodyMesh.instanceMatrix.needsUpdate = true
  bodyMesh.instanceColor!.needsUpdate = true
  headMesh.instanceMatrix.needsUpdate = true
  headMesh.instanceColor!.needsUpdate = true
  composer.render()
  requestAnimationFrame(animate)
}

animate()
