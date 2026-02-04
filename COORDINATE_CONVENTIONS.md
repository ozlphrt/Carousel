# Coordinate Conventions

## Global Standard
Right-handed, Y-up
X: East(+)/West(-)
Y: Up(+)/Down(-)
Z: South(+)/North(-)
Origin: Center of world grid
Units: 1 = 1 meter or 1 grid cell

## Three.js Declaration
```js
const coordinateSystem = { handedness: 'right', up: 'Y', origin: 'center', units: 'meters' };
```

## Matrix Trace
```
vec_ndc = projection * view * model * vec_local
```

