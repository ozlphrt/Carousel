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
  obstacleCount: 12,
  obstacleRadius: 0.3
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

// --- Scene Setup ---
const canvas = document.createElement('canvas')
document.body.appendChild(canvas)

const scene = new THREE.Scene()
scene.background = new THREE.Color(config.backgroundColor)
scene.fog = new THREE.FogExp2(config.backgroundColor, 0.02)

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
const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()
const planeGeometry = new THREE.PlaneGeometry(100, 100)
const plane = new THREE.Mesh(planeGeometry, new THREE.MeshBasicMaterial({ visible: false }))
plane.rotation.x = -Math.PI / 2
plane.position.y = 0.5
scene.add(plane)

let draggedObject: THREE.Object3D | null = null

window.addEventListener('pointerdown', (event) => {
  pointer.x = (event.clientX / window.innerWidth) * 2 - 1
  pointer.y = -(event.clientY / window.innerHeight) * 2 + 1

  raycaster.setFromCamera(pointer, camera)
  const intersects = raycaster.intersectObjects(obstacleMeshes)

  if (intersects.length > 0) {
    draggedObject = intersects[0].object
    controls.enabled = false
  }
})

window.addEventListener('pointermove', (event) => {
  pointer.x = (event.clientX / window.innerWidth) * 2 - 1
  pointer.y = -(event.clientY / window.innerHeight) * 2 + 1

  if (draggedObject) {
    raycaster.setFromCamera(pointer, camera)
    const intersects = raycaster.intersectObject(plane)
    if (intersects.length > 0) {
      const pt = intersects[0].point
      const dist = Math.sqrt(pt.x * pt.x + pt.z * pt.z)
      const maxR = config.platformRadius - 0.5

      if (dist < maxR) {
        draggedObject.position.set(pt.x, draggedObject.position.y, pt.z)
        // Update collision data
        const index = obstacleMeshes.indexOf(draggedObject as THREE.Mesh)
        if (index !== -1) {
          obstacleData[index * 3] = pt.x
          obstacleData[index * 3 + 1] = pt.z
        }
      }
    }
  }
})

window.addEventListener('pointerup', () => {
  draggedObject = null
  controls.enabled = true
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

const gridHelper = new THREE.PolarGridHelper(config.platformRadius, 16, 10, 64, 0x888888, 0x444444)
gridHelper.position.y = 0.01
scene.add(gridHelper)

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

// Match Platform Material
const obstacleMaterial = new THREE.MeshStandardMaterial({
  color: config.obstacleColor,
  roughness: 0.8,
  metalness: 0.2,
  envMapIntensity: 0.5
})

for (let i = 0; i < config.obstacleCount; i++) {
  const obs = new THREE.Mesh(obstacleGeometry, obstacleMaterial.clone())
  obs.castShadow = true
  obs.receiveShadow = true

  // Correction: Extrude is Z-up, we need Y-up
  obs.rotation.x = -Math.PI / 2

  scene.add(obs)
  obstacleMeshes.push(obs)

  const angle = Math.random() * Math.PI * 2
  const rRandom = Math.random()
  let obsR = 0.0
  if (rRandom > 0.7) {
    obsR = 1.0 + Math.random() * 0.3
  } else {
    obsR = 0.3 + Math.random() * 0.5
  }

  const obsHeight = 0.36
  const distRangeMin = config.poleRadius + obsR + 0.2
  const distRangeMax = config.platformRadius - obsR - 0.2
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
const _white = new THREE.Color(0xffffff)
const _targetColor = new THREE.Color()
const _baseColor = new THREE.Color()

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
  particleMaterial.color.set(c)
  particleMaterial.emissive.set(c)
})
sceneFolder.add(config, 'bloomStrength', 0, 0.2).onChange((v: number) => bloomPass.strength = v)
sceneFolder.add(config, 'bloomRadius', 0, 1).onChange((v: number) => bloomPass.radius = v)

const physicsFolder = gui.addFolder('Physics')
physicsFolder.add(config, 'speed', 0, 1)
physicsFolder.add(config, 'separationForce', 0, 4)
physicsFolder.add(config, 'centrifugalForce', -0.3, 0.1).name('Centrifugal Force')
physicsFolder.add(config, 'vortexStrength', 0, 2).name('Vortex Strength')
physicsFolder.add(config, 'particleCount').name('Active Count').listen().disable()

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
let lastSpawnTime = 0
const TARGET_POPULATION = 15000

function animate() {
  const now = performance.now()
  frames++
  if (now - lastFpsUpdate >= 500) {
    const fps = Math.round((frames * 1000) / (now - lastFpsUpdate))
    fpsDiv.innerText = `FPS: ${fps} | Count: ${config.particleCount}`
    lastFpsUpdate = now
    frames = 0
  }

  // Continuous Spawning
  if (config.particleCount < TARGET_POPULATION) {
    const spawnRate = 2
    const startIdx = config.particleCount
    const endIdx = Math.min(startIdx + spawnRate, TARGET_POPULATION)

    for (let i = startIdx; i < endIdx; i++) {
      initParticle(i)
    }

    config.particleCount = endIdx
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

    // 0. Static Obstacles (skip for leaving particles)
    if (state !== STATE_LEAVING) {
      for (let k = 0; k < config.obstacleCount; k++) {
        const ox = obstacleData[k * 3]
        const oz = obstacleData[k * 3 + 1]
        const or = obstacleData[k * 3 + 2]

        const dx = x - ox
        const dz = z - oz
        const dSq = dx * dx + dz * dz

        const minDist = r1 + or
        if (dSq < minDist * minDist) {
          const d = Math.sqrt(dSq)
          const pen = minDist - d
          const nx = dx / d
          const nz = dz / d

          const pushFactor = 0.2
          x += nx * pen * pushFactor
          z += nz * pen * pushFactor

          vx *= 0.5
          vz *= 0.5
        }
      }
    }

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
                  const push = overlap * 0.5
                  const pushMult = (state === STATE_ORBITING) ? 0.2 : 0.5
                  x += nx * push * pushMult
                  z += nz * push * pushMult
                }

                // Separation
                const force = (softRadius - d) / d
                sepX += nx * force
                sepZ += nz * force
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

      // Dynamic Flow
      let spiralDesire = 0.0
      if (dist < 2.5) spiralDesire = 1.0
      if (localDensity > 2) spiralDesire = Math.max(spiralDesire, Math.min(1.0, (localDensity - 2) * 0.3))

      let dx = tx * spiralDesire + rx * (1.0 - spiralDesire * 0.5)
      let dz = tz * spiralDesire + rz * (1.0 - spiralDesire * 0.5)

      const len = Math.sqrt(dx * dx + dz * dz)
      if (len > 0) { dx /= len; dz /= len; }

      let speedFactor = 1.0
      if (dist > 0.1 && dist < 5.0) {
        speedFactor = 1.0 + config.vortexStrength * (5.0 / dist - 1.0)
        speedFactor = Math.max(0.1, Math.min(speedFactor, 3.0))
      }

      const currentSpeed = config.speed * speedFactor * mySpeedMult
      const desiredVx = dx * currentSpeed
      const desiredVz = dz * currentSpeed

      // Steering
      let steeringX = desiredVx - vx
      let steeringZ = desiredVz - vz
      const maxSteer = 0.02 * myAgilityMult

      const steerLen = Math.sqrt(steeringX * steeringX + steeringZ * steeringZ)
      if (steerLen > maxSteer) {
        steeringX = (steeringX / steerLen) * maxSteer
        steeringZ = (steeringZ / steerLen) * maxSteer
      }

      vx += steeringX
      vz += steeringZ

      if (dist > 0.001) {
        vx -= (x / dist) * config.centrifugalForce * 0.1
        vz -= (z / dist) * config.centrifugalForce * 0.1
      }

      // Touch Check
      if (dist < config.poleRadius + r1 + 0.1) {
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

      // Boundaries (only for seeking)
      if (dist < minR) {
        const angle = Math.atan2(z, x)
        x = Math.cos(angle) * minR
        z = Math.sin(angle) * minR
      }
      if (dist > maxR) {
        const angle = Math.atan2(z, x)
        x = Math.cos(angle) * maxR
        z = Math.sin(angle) * maxR
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

      // Color Graduation (Only Changes Head)
      const progress = Math.min(1.0, acc / (Math.PI * 2))
      const baseHex = particles[i * STRIDE + 9]
      _baseColor.setHex(baseHex)
      _color.lerpColors(_baseColor, _targetColor, progress)
      headMesh.setColorAt(i, _color)

      // Transition to leaving after one full orbit
      if (acc > Math.PI * 2) {
        state = STATE_LEAVING
        particles[i * STRIDE + 7] = STATE_LEAVING
        // Reset velocity to purely radial (outward) direction
        const radialSpeed = 0.08
        vx = rx * radialSpeed
        vz = rz * radialSpeed
      }

    } else if (state === STATE_LEAVING) {
      // LEAVING BEHAVIOR - drift away and fade out
      if (dist > 0.01) {
        const rx = x / dist
        const rz = z / dist
        // Gentle outward acceleration for controlled drift
        vx += rx * 0.05
        vz += rz * 0.05
        // Light friction for smooth drift
        vx *= 0.99
        vz *= 0.99
      }

      // Slow shrink effect so particles stay visible longer
      r1 *= 0.985
      particles[i * STRIDE + 4] = r1

      // Respawn if vanished or drifted far away
      if (r1 < 0.001 || dist > config.platformRadius * 1.8) {
        initParticle(i)
        continue
      }
    }

    // Speed limit (but not for leaving particles - they need to escape!)
    if (state !== STATE_LEAVING) {
      const speedLimit = config.speed * 1.5 * mySpeedMult
      const currentVel = Math.sqrt(vx * vx + vz * vz)
      if (currentVel > speedLimit) {
        vx = (vx / currentVel) * speedLimit
        vz = (vz / currentVel) * speedLimit
      }
    }

    x += vx * dt
    z += vz * dt

    particles[i * STRIDE] = x
    particles[i * STRIDE + 1] = z
    particles[i * STRIDE + 2] = vx
    particles[i * STRIDE + 3] = vz

    // Universal respawn check - safety net for particles that escape boundaries
    // (Leaving particles have their own respawn logic above)
    if (state !== STATE_LEAVING) {
      const currentDist = Math.sqrt(x * x + z * z)
      if (currentDist > config.platformRadius * 1.05 || isNaN(x) || isNaN(z)) {
        initParticle(i)
        continue
      }
    }

    // Update Meshes (Size is restored to normal)
    const normalizedScale = r1 / (0.03 * 1.5)
    updateParticleMesh(i, x, z, normalizedScale)
  }

  bodyMesh.instanceMatrix.needsUpdate = true
  headMesh.instanceMatrix.needsUpdate = true
  headMesh.instanceColor!.needsUpdate = true
  composer.render()
  requestAnimationFrame(animate)
}

animate()
