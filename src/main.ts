import './style.css'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import GUI from 'lil-gui'

// --- Configuration ---
const config = {
  platformRadius: 10,
  poleRadius: 1,
  poleHeight: 0.9,
  particleCount: 15721,
  particleRadius: 0.08,
  backgroundColor: '#2a2a2a',
  platformColor: '#5a5a5a',
  obstacleColor: '#5a5a5a',   // Match Platform
  poleColor: '#0088ff',       // Blue
  particleColor: '#00e5ff',
  speed: 0.3,
  separationForce: 1.44,
  centrifugalForce: -0.2,
  vortexStrength: 0.0,
  poleOpacity: 0.343,
  bloomStrength: 0.1398,
  bloomRadius: 0.5,
  bloomThreshold: 0,
  obstacleCount: 15,
  obstacleRadius: 0.3,
  debugMode: false, // Toggle for debugging
  showTrails: false,
  trailLength: 30,
  showPheromones: false
}

// --- Global Data definitions ---
const MAX_PARTICLE_COUNT = 20000
config.particleCount = 100

// STRIDE 12 for extra state data
// 0:x, 1:z, 2:vx, 3:vz, 4:r, 5:speedMult, 6:agility, 7:state, 8:accumAngle, 9:baseColor, 10:orbitRadius, 11:reserved
const STRIDE = 12
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
  color: 0xff0000,
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

const composer = new EffectComposer(renderer)
composer.addPass(renderScene)
composer.addPass(bloomPass)

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

// Updated Palette: Black, Yellow, White tones
const palette = [
  0xffffff, // White
  0xeeeeee, // Off-white
  0x111111, // Very Dark / Black
  0x222222, // Dark Grey
  0xfffdd0, // Cream
  0xf0e68c, // Khaki (Pale Yellow)
  0xf5f5dc  // Beige
]

const STATE_SEEKING = 0
const STATE_ORBITING = 1
const STATE_LEAVING = 2

function initParticle(i: number) {
  const scale = 0.9 + Math.random() * 0.2
  const pRadius = 0.03 * scale * 1.5

  // Random Entrance (360 deg)
  const angle = Math.random() * Math.PI * 2
  const startRadius = config.platformRadius - 0.5

  const x = Math.cos(angle) * startRadius
  const z = Math.sin(angle) * startRadius

  // Traits
  const speedMult = 0.7 + Math.random() * 0.6
  const agilityMult = 0.5 + Math.random() * 1.0

  particles[i * STRIDE] = x
  particles[i * STRIDE + 1] = z

  // Rush Inwards
  const speed = (config.speed * 1.5) * speedMult
  particles[i * STRIDE + 2] = -Math.cos(angle) * speed
  particles[i * STRIDE + 3] = -Math.sin(angle) * speed

  particles[i * STRIDE + 4] = pRadius
  particles[i * STRIDE + 5] = speedMult
  particles[i * STRIDE + 6] = agilityMult
  particles[i * STRIDE + 7] = STATE_SEEKING
  particles[i * STRIDE + 8] = 0 // accumAngle

  // Reset Trail for this particle
  resetTrail(i, x, 0.09 * scale, z)

  const colorHex = palette[Math.floor(Math.random() * palette.length)]
  particles[i * STRIDE + 9] = colorHex // Base color

  // Set positions
  updateParticleMesh(i, x, z, scale)

  // Color: Applies to BOTH Body and Head initially
  _color.setHex(colorHex)
  headMesh.setColorAt(i, _color)
  bodyMesh.setColorAt(i, _color)
}

function updateParticleMesh(i: number, x: number, z: number, scale: number) {
  // Body (Capsule) - pivot is center.
  // Center Y = 0.09 * scale
  dummy.position.set(x, 0.09 * scale, z)
  dummy.scale.set(scale, scale, scale)
  dummy.updateMatrix()
  bodyMesh.setMatrixAt(i, dummy.matrix)

  // Head (Sphere overlay) - Offset Y = 0.06 (half height of cylinder straight part)
  dummy.position.set(x, (0.09 + 0.06) * scale, z)
  dummy.scale.set(scale, scale, scale)
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
    const x = particles[i * STRIDE]
    const z = particles[i * STRIDE + 1]

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
      particles[i * STRIDE + 7] = STATE_SEEKING
    }
  } else {
    // Clear labels
    debugLabels.forEach(l => scene.remove(l))
    debugLabels.length = 0
  }
}

gui.add(config, 'debugMode').name('Debug Mode (100 Ppl)').onChange(updateDebugMode)

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

function animate() {
  const now = performance.now()
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

    // DEBUG MODE: Prevent spawning beyond 100
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
  updateGrid() // Updates gridHead

  const dt = 0.016
  const dim = GRID_DIM

  _targetColor.set(config.poleColor)

  for (let i = 0; i < config.particleCount; i++) {
    // Current State
    let x = particles[i * STRIDE]
    let z = particles[i * STRIDE + 1]
    let vx = particles[i * STRIDE + 2]
    let vz = particles[i * STRIDE + 3]
    let r1 = particles[i * STRIDE + 4] // allow modifying radii
    const mySpeedMult = particles[i * STRIDE + 5]
    const myAgilityMult = particles[i * STRIDE + 6]
    let state = particles[i * STRIDE + 7]

    const minR = config.poleRadius + r1
    const maxR = config.platformRadius - r1


    // 1. Neighbor Physics
    let sepX = 0
    let sepZ = 0
    let localDensity = 0

    const col = Math.floor((x + gridOffset) / cellSize)
    const row = Math.floor((z + gridOffset) / cellSize)

    const softThresholdFactor = 1.2

    // Check neighbors 3x3
    for (let r = row - 1; r <= row + 1; r++) {
      for (let c = col - 1; c <= col + 1; c++) {
        if (r >= 0 && r < dim && c >= 0 && c < dim) {
          const cellIndex = r * dim + c
          let j = gridHead[cellIndex]

          while (j !== -1) {
            if (i !== j) {
              const jx = particles[j * STRIDE]
              const jz = particles[j * STRIDE + 1]
              const r2 = particles[j * STRIDE + 4]

              const dx = x - jx
              const dz = z - jz
              const dSq = dx * dx + dz * dz

              const combinedRadius = r1 + r2
              const softRadius = combinedRadius * softThresholdFactor

              // Density check
              if (dSq < softRadius * softRadius * 1.5) {
                localDensity++
              }

              if (dSq > 0 && dSq < softRadius * softRadius) {
                const d = Math.sqrt(dSq)
                const nx = dx / d
                const nz = dz / d

                // Rigid overlap
                if (d < combinedRadius) {
                  const overlap = combinedRadius - d
                  const push = overlap * 0.45 // Slightly softened from 0.5
                  const pushMult = (state === STATE_ORBITING) ? 0.15 : 0.4 // Softened
                  x += nx * push * pushMult
                  z += nz * push * pushMult
                }

                // Separation
                const force = (softRadius - d) / d
                sepX += nx * force * 0.8 // Smoother separation
                sepZ += nz * force * 0.8
              }
            }
            j = gridNext[j]
          }
        }
      }
    }

    if (state !== STATE_ORBITING && state !== STATE_LEAVING) {
      vx += sepX * config.separationForce * 0.05
      vz += sepZ * config.separationForce * 0.05
    }

    // --- State Logic ---
    const dist = Math.sqrt(x * x + z * z)

    if (state === STATE_SEEKING) {
      // SEEKING BEHAVIOR
      const rx = -x / dist
      const rz = -z / dist
      const tx = -z / dist
      const tz = x / dist

      // Dynamic Flow - only spiral when very close to pole
      let spiralDesire = 0.0
      if (dist < 1.2) spiralDesire = 1.0  // Reduced from 2.5 to allow particles to reach pole
      if (localDensity > 2) spiralDesire = Math.max(spiralDesire, Math.min(1.0, (localDensity - 2) * 0.3))

      let dx = tx * spiralDesire + rx * (1.0 - spiralDesire * 0.5)
      let dz = tz * spiralDesire + rz * (1.0 - spiralDesire * 0.5)

      const len = Math.sqrt(dx * dx + dz * dz)
      if (len > 0) { dx /= len; dz /= len; }

      let speedFactor = 1.0
      if (dist > 0.1 && dist < 5.0) {
        speedFactor = 1.0 + config.vortexStrength * (5.0 / dist - 1.0)
        // Add "Excitement": Speed increases as they get closer to the pole
        const proximityExcitement = Math.max(0, 1.0 - (dist - config.poleRadius) / 5.0)
        speedFactor *= (1.0 + proximityExcitement * 0.8)
        speedFactor = Math.max(0.1, Math.min(speedFactor, 4.0))
      }

      const currentSpeed = config.speed * speedFactor * mySpeedMult
      const desiredVx = dx * currentSpeed
      const desiredVz = dz * currentSpeed

      // Steering Excitement: agility increase as they get closer
      const proximityExcitement = Math.max(0, 1.0 - (dist - config.poleRadius) / 3.0)
      const dynamicAgility = myAgilityMult * (1.0 + proximityExcitement * 2.0)

      // Steering
      let steeringX = desiredVx - vx
      let steeringZ = desiredVz - vz
      const maxSteer = 0.05 * dynamicAgility // Increased based on proximity

      const steerLen = Math.sqrt(steeringX * steeringX + steeringZ * steeringZ)
      if (steerLen > maxSteer) {
        steeringX = (steeringX / steerLen) * maxSteer
        steeringZ = (steeringZ / steerLen) * maxSteer
      }

      vx += steeringX * 0.8 // Slightly dampened steering to reduce jitter
      vz += steeringZ * 0.8

      if (dist > 0.001) {
        vx -= (x / dist) * config.centrifugalForce * 0.05 // Reduced from 0.1
        vz -= (z / dist) * config.centrifugalForce * 0.05
      }

      // Touch Check - particles must actually touch the pole to start orbiting
      if (dist < config.poleRadius + r1) {
        state = STATE_ORBITING
        particles[i * STRIDE + 7] = STATE_ORBITING
        particles[i * STRIDE + 8] = 0 // Reset angle accumulator
        particles[i * STRIDE + 10] = dist // Store orbit radius

        const orbitSpeed = config.speed
        const tangX = -z / dist
        const tangZ = x / dist

        vx = tangX * orbitSpeed
        vz = tangZ * orbitSpeed
      }

      // Inner boundary only - prevent particles from going through the pole
      if (dist < minR) {
        const angle = Math.atan2(z, x)
        x = Math.cos(angle) * minR
        z = Math.sin(angle) * minR
      }

      // Outer boundary - prevent particles from leaving the platform
      if (dist > maxR) {
        const angle = Math.atan2(z, x)
        x = Math.cos(angle) * maxR
        z = Math.sin(angle) * maxR

        // If moving outward, cancel that component and push inward STRONGLY
        const rx = x / dist
        const rz = z / dist
        const vDotR = vx * rx + vz * rz

        if (vDotR > 0) {
          vx -= rx * vDotR // Kill outward velocity
          vz -= rz * vDotR

          // Stronger inward bounce to overcome separation forces
          vx -= rx * 0.05
          vz -= rz * 0.05
        }
      } else if (dist > config.platformRadius * 0.9) {
        // Soft Edge Repulsion: If very close to edge, add extra inward desire
        const rx = x / dist
        const rz = z / dist
        vx -= rx * 0.01
        vz -= rz * 0.01
      }

    } else if (state === STATE_ORBITING) {
      // ORBITING BEHAVIOR
      const orbitRadius = particles[i * STRIDE + 10]
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

      // Track angle traveled
      const angularVel = orbitSpeed / dist
      const dAngle = angularVel * dt

      let acc = particles[i * STRIDE + 8]
      acc += dAngle
      particles[i * STRIDE + 8] = acc

      // Color graduation removed - particles keep original colors

      // After 3 complete orbits, particle loses interest and starts drifting away
      // After 3 complete orbits, particle loses interest and starts drifting away
      if (acc > Math.PI * 2 * 3) {
        state = STATE_LEAVING
        particles[i * STRIDE + 7] = STATE_LEAVING
        // Set gentle outward velocity
        const rx = x / dist
        const rz = z / dist
        vx = rx * 0.03
        vz = rz * 0.03
      }
      // Transition to leaving after one full orbit - DISABLED
      // Particles now orbit indefinitely without leaving
    } else if (state === STATE_LEAVING) {
      // Safety check: if in LEAVING state but haven't completed 3 orbits, reset to seeking
      const acc = particles[i * STRIDE + 8]
      if (acc < Math.PI * 2 * 3) {
        state = STATE_SEEKING
        particles[i * STRIDE + 7] = STATE_SEEKING
        particles[i * STRIDE + 8] = 0
      } else {
        // LEAVING BEHAVIOR - slowly drift away after orbiting
        if (dist > 0.01) {
          const rx = x / dist
          const rz = z / dist
          // Very gentle outward acceleration (Red drift)
          vx += rx * 0.005
          vz += rz * 0.005
          // Friction to make it look "disinterested"
          vx *= 0.99
          vz *= 0.99
        }

        // Respawn immediately when reaching the platform limit
        const currentDist = Math.sqrt(x * x + z * z)
        if (currentDist > config.platformRadius) {
          initParticle(i)
          continue
        }
      }
    }

    // Speed limit for all particles
    const speedLimit = config.speed * 1.5 * mySpeedMult
    const currentVel = Math.sqrt(vx * vx + vz * vz)
    if (currentVel > speedLimit) {
      vx = (vx / currentVel) * speedLimit
      vz = (vz / currentVel) * speedLimit
    }

    x += vx * dt
    z += vz * dt

    // Post-Integration Static Obstacles (Strict Constraint)
    for (let k = 0; k < config.obstacleCount; k++) {
      const ox = obstacleData[k * 3]
      const oz = obstacleData[k * 3 + 1]
      // Radius Correction: Scale * (Base 1.0 + Bevel 0.1) + Buffer ~0.05
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

        // Soft resolve 85% to reduce jitter
        const softPen = pen * 0.85
        x += nx * softPen
        z += nz * softPen

        // Deflect velocity
        const vDotN = vx * nx + vz * nz
        if (vDotN < 0) {
          vx -= nx * vDotN * 1.05 // Slight extra bounce to keep away
          vz -= nz * vDotN * 1.05
        }
      }
    }

    // Hard Central Pole Constraint (Solid Material)
    const dPoleSq = x * x + z * z
    const minPoleDist = config.poleRadius + r1
    if (dPoleSq < minPoleDist * minPoleDist) {
      const d = Math.sqrt(dPoleSq)
      if (d > 0.0001) {
        const nx = x / d
        const nz = z / d
        // Soft resolve 90% for the pole to avoid snapping
        const pen = minPoleDist - d
        x += nx * pen * 0.9
        z += nz * pen * 0.9

        // Kill inward component and add a tiny radial push
        const vDotN = vx * nx + vz * nz
        if (vDotN < 0) {
          vx -= nx * vDotN
          vz -= nz * vDotN
        }
        vx += nx * 0.001 // Micro push
        vz += nz * 0.001
      } else {
        // Fallback for extreme center case
        x = minPoleDist
        z = 0
      }
    }

    particles[i * STRIDE] = x
    particles[i * STRIDE + 1] = z
    particles[i * STRIDE + 2] = vx
    particles[i * STRIDE + 3] = vz

    // Universal respawn check - safety net for particles that escape boundaries
    // (Leaving particles have their own respawn logic above)
    if (state !== STATE_LEAVING) {
      const currentDist = Math.sqrt(x * x + z * z)
      if (currentDist > config.platformRadius * 2.0 || isNaN(x) || isNaN(z)) {
        initParticle(i)
        continue
      }
    }

    // Color Logic for Debug Mode
    // Color Logic: Red if Orbiting/Leaving, else Base Color
    if (state === STATE_ORBITING || state === STATE_LEAVING) {
      _color.setHex(0xff0000) // RED
      bodyMesh.setColorAt(i, _color)
      headMesh.setColorAt(i, _color)

      // Label Logic (Debug Mode Only)
      if (config.debugMode) {
        const turns = Math.floor(particles[i * STRIDE + 8] / (Math.PI * 2))

        // Ensure label exists for this particle index 'i' relative to our debug list
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

        // Update texture if turn count changed
        if (label.userData.turns !== turns) {
          label.material.map = getTextureForNumber(turns)
          label.userData.turns = turns
        }
      }
    } else {
      // Restore original color
      const baseColorHex = particles[i * STRIDE + 9]
      _color.setHex(baseColorHex)
      bodyMesh.setColorAt(i, _color)
      headMesh.setColorAt(i, _color)

      // Hide label if it exists (for when it respawns or leaves orbiting state)
      if (debugLabels[i]) {
        debugLabels[i].visible = false
      }
    }

    // Update Meshes (Size is restored to normal)
    const normalizedScale = r1 / (0.03 * 1.5)
    updateParticleMesh(i, x, z, normalizedScale)

    // --- Trail Update ---
    if (config.showTrails) {
      // Only update if relevant state (Orbiting/Leaving) -> Red particles
      // Or simpler: Update ALL, but maybe that's too expensive?
      // User asked "trace behind the RED people".

      const isRed = (state === STATE_ORBITING || state === STATE_LEAVING)

      if (isRed) {
        // 0. Check for discontinuity (Stale history or Teleport)
        const peekIdx = (i * MAX_TRAIL_LENGTH + trailHeads[i]) * 3
        const lastX = trailHistory[peekIdx]
        const lastZ = trailHistory[peekIdx + 2]

        // If last point is far away (e.g. > 1 unit) or 'empty' (99999), reset.
        const dSq = (x - lastX) * (x - lastX) + (z - lastZ) * (z - lastZ)

        if (dSq > 1.0 || lastX > 5000) {
          resetTrail(i, x, 0.1, z)
        }

        // 1. Advance head
        let head = trailHeads[i]
        head = (head + 1) % config.trailLength
        trailHeads[i] = head

        // 2. Write new pos to history
        // Offset Y slightly (0.1) so it doesn't clip floor
        const hIdx = (i * MAX_TRAIL_LENGTH + head) * 3
        trailHistory[hIdx] = x
        trailHistory[hIdx + 1] = 0.1
        trailHistory[hIdx + 2] = z

        // 3. Update Geometry Line Segments
        // Segment J connects History[(head - J)] to History[(head - J - 1)]
        // We need to write into 'trailPositions'

        // Base offset for this particle's vertices in the single geometry
        const vBase = i * SEGMENTS_PER_PARTICLE * 2 * 3

        for (let s = 0; s < config.trailLength - 1; s++) {
          // Current point index in Ring Buffer
          let currRingIdx = (head - s)
          if (currRingIdx < 0) currRingIdx += config.trailLength

          let prevRingIdx = (head - s - 1)
          if (prevRingIdx < 0) prevRingIdx += config.trailLength

          const p1Idx = (i * MAX_TRAIL_LENGTH + currRingIdx) * 3
          const p2Idx = (i * MAX_TRAIL_LENGTH + prevRingIdx) * 3

          // Write Segment s
          // Vertex 1
          trailPositions[vBase + s * 6 + 0] = trailHistory[p1Idx]
          trailPositions[vBase + s * 6 + 1] = trailHistory[p1Idx + 1]
          trailPositions[vBase + s * 6 + 2] = trailHistory[p1Idx + 2]

          // Vertex 2
          trailPositions[vBase + s * 6 + 3] = trailHistory[p2Idx]
          trailPositions[vBase + s * 6 + 4] = trailHistory[p2Idx + 1]
          trailPositions[vBase + s * 6 + 5] = trailHistory[p2Idx + 2]
        }

      } else {
        // Not red: collapse trail to current pos invisible
        // Or just don't update? If we don't update, old trail freezes.
        // Better to collapse it.
        // Optimization: check if already collapsed?

        // Just reset history head to current pos
        // To "Hide", we can set all vertices to 0,0,0
        // But let's just use resetTrail logic lazily?
        // Actually, let's just write NaNs or far away points into the vertex buffer?
        // Fast check: if not red, just skip? No, we need to clear artifacts.

        // Ideally we only run this once when state changes, but we don't track state change here.
        // Let's just set the first vertex to 99999?
        // No, LineSegments renders everything.

        // Quick hack: If not red, set all segments for this particle to 99999
        // Only update if it WAS red recently?
        // Let's just do it every frame for non-reds until we optimize.

        // Optimization: Only update if the first vertex is NOT 99999
        const vBase = i * SEGMENTS_PER_PARTICLE * 2 * 3
        if (trailPositions[vBase] < 5000) { // If visible
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

  // --- Pheromone Update ---
  if (config.showPheromones) {
    pheromoneMesh.visible = true

    // 1. Fade out (Decay)
    pheromoneCtx.fillStyle = 'rgba(0, 0, 0, 0.05)'
    pheromoneCtx.fillRect(0, 0, PHEROMONE_SIZE, PHEROMONE_SIZE)

    // 2. Draw active red particles
    // Optimize: Only iterate if we have some particles?
    pheromoneCtx.fillStyle = 'rgba(255, 50, 50, 0.5)'
    pheromoneCtx.beginPath()

    // Map world to canvas. World range approx +/- 12 for safety.
    const mapRange = 24.0 // matches plane geometry size
    const halfMap = mapRange / 2.0

    let pointsDrawn = 0

    for (let i = 0; i < config.particleCount; i++) {
      // Red check: Orbiting or Leaving
      // We can check state directly without array lookup if possible, but stuck with array
      const state = particles[i * STRIDE + 7]

      if (state === STATE_ORBITING || state === STATE_LEAVING) {
        const x = particles[i * STRIDE]
        const z = particles[i * STRIDE + 1]

        // Map x [-12, 12] -> [0, 1024]
        // u = (x + 12) / 24
        const u = (x + halfMap) / mapRange
        const v = (z + halfMap) / mapRange

        if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
          const px = u * PHEROMONE_SIZE
          const py = v * PHEROMONE_SIZE // Inverted Y? Z grows down in 2D? typically +Z is down/south in 3D (top view)
          // Canvas Y is down. Z is "down" in top-down view. So +Z maps to +Y. correct.

          pheromoneCtx.moveTo(px, py)
          pheromoneCtx.arc(px, py, 3, 0, Math.PI * 2) // Radius 3 pixels
          pointsDrawn++
        }
      }
    }

    if (pointsDrawn > 0) {
      pheromoneCtx.fill()
    }

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
