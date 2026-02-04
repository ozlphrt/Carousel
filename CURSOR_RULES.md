# 🧭 CURSOR_RULES.md
**Global Operational Manual for Cursor AI**
**Version:** 1.0
**Scope:** Universal rules governing all projects (simulations, UI/UX, documentation, 3D, games, assets, etc.)
**Tone:** Balanced — strict where structure matters, flexible where creativity helps.

---

## 1. Core Principles
1. **Clarity before Code** — always read markdown context before writing. 
2. **Context Persistence** — all assumptions, especially coordinates, must be traceable. 
3. **No Blind Generation** — never output code or docs without verifying context. 
4. **Version Integrity** — append or branch; never overwrite unless told. 

---

## 2. File & Documentation Rules
- Use `snake_case` filenames, `PascalCase` components, `camelCase` vars/functions. 
- Always suffix versions (`_v22_4`, `_revB`). 
- Maintain:
 - `PROJECT_OVERVIEW.md`
 - `TASK_LIST.md`
 - `TECHNICAL_SETUP.md`
 - `COORDINATE_CONVENTIONS.md`
 - `PERFORMANCE_LOG.md`
 - `DECISIONS.md`
 - `CURSOR_RULES.md`

---

## 3. Prompt & Behavioral Protocols
- Read all markdowns before generating. 
- Confirm directory & naming consistency. 
- Ask clarifying questions when unsure. 
- Comment coordinate assumptions & matrix transforms in code. 
- After generation: validate coherence and log updates. 

---

## 4. Context Continuity Protocol
- Always check markdowns before coding. 
- If context lost: reread `PROJECT_OVERVIEW.md` + `COORDINATE_CONVENTIONS.md`. 
- Confirm recovery with: 
 > “Context realigned successfully according to COORDINATE_CONVENTIONS.md.” 

---

## 5. Version Control & GitHub Integration
1. Commit format:
 ```
 <type>(<scope>): <summary> — <impact>
 ```
2. Branch format:
 ```
 feat/<scope> , fix/<scope> , docs/<scope> , perf/<scope> , refactor/<scope>
 ```
3. Never push directly to `main` without explicit approval. 

---

## 6. Coordinate System Governance

### 6.1 Global Standard
```
Right-handed, Y-up
X: East(+)/West(-)
Y: Up(+)/Down(-)
Z: South(+)/North(-)
Origin: Center of world grid
Units: 1 = 1 meter or 1 grid cell
```

### 6.2 Three.js Enforcement
```js
const coordinateSystem = { handedness:'right', up:'Y', origin:'center', units:'meters' };
```
Always define axes, never assume defaults.

### 6.3 Verification
- Display `AxesHelper`, `GridHelper`, object origins. 
- Test round-trip conversions (`hexToWorld` → `worldToHex`). 
- Maintain debug toggles. 

### 6.4 UI Integration
Show on-screen coordinates:
```jsx
X: {x.toFixed(2)} | Y: {y.toFixed(2)} | Z: {z.toFixed(2)}
```

### 6.5 Checklist
- [ ] System documented 
- [ ] Transform tests pass 
- [ ] Visual debug enabled 
- [ ] Naming consistent 
- [ ] Round-trip verified 

**Golden Rule:** verify visually first, then scale complexity.

### 6.6 Space Declarations & Matrix Traces (Three.js)
- **MUST** declare source and target spaces on every transformation: `local → world`, `world → view`, `view → NDC`, etc. 
- **MUST** name matrices used: `model`, `modelView`, `projection`, `normalMatrix`, `viewProjection`. 
- **MUST NOT** propose a transform without stating spaces and matrices. 
- When diagnosing, include a one-liner matrix trace, e.g.: 
 ```
 vec_ndc = projection * view * model * vec_local
 ```

### 6.7 Camera Controls Protocol (Three.js)
- **Default**: `OrbitControls` (left-drag rotate, right-drag pan, wheel zoom). 
- **State camera**: position, target, `up`, and current `view` matrix. 
- **Show interplay**: how controls update camera (e.g., target orbit vs freefly). 
- **No assumptions** about default up/orientation; verify before changes. 
- **Switching controls** (e.g., Orbit → FirstPerson): 
 1) persist camera state (pos/target/up), 
 2) dispose old controls cleanly, 
 3) init new controls with the persisted state, 
 4) confirm no “jump” via a single preview frame.

---

## 7. Performance & Optimization
- Target 60 FPS under load. 
- Log particle count, frame-time, GPU metrics. 

---

## 8. UI/UX Guidelines
- Dark glassmorphic panels (`rgba(0,0,0,0.6)`, `blur(10px)`). 
- Hover-drag numeric inputs preferred. 
- Rounded corners, subtle shadows, auto-hide sidebars.

### 8.3 Interaction Input Policy
- **Sliders are banned by default.** Use **hover+drag** with delta mapping. 
- Allow sliders only with `[local_override: sliders_ok]` in project docs. 
- **Show mapping math** in code comments or UI docs: 
 ```
 value_next = clamp(value_prev + sensitivity * delta_pixels, min, max)
 ```
 

---

## 9. Error Handling & Recovery
- On errors: capture message + context in `DECISIONS.md`. 
- Retry simplified version. 
- Rebuild coordinate context before continuing. 

---

## 10. Update Protocol
- Increment version (`v1.1`, `v1.2`) on edits. 
- Verify consistency before approval. 
- Universal rules override project ones unless `[local_override]` tag present. 

---

## 11. Enforcement Matrix
| Category | Enforcement | Overridable |
|-----------|--------------|-------------|
| Context Continuity | Strict | No |
| Coordinate Consistency | Strict | No |
| UI/UX | Balanced | Yes |
| Code Architecture | Balanced | Conditional |
| Markdown Integrity | Strict | No |
| Performance Targets | Balanced | Yes |

---

## 12. Closing Principle
> Cursor operates as a structured creative partner — free to innovate **within verified bounds**.

---

## 13. Behavioral Directives (Concise / Critical / Diagnostic)

### 13.1 Concise Reply
- Keep responses short, structured, task-focused. 
- Default template:
 ```
 Summary: …
 Why: …
 Next: …
 ```

### 13.2 Challenge Protocol
- Always propose better options when clear.
 ```
 Observation: …
 Recommendation: …
 Tradeoff: …
 If declined: …
 ```

### 13.3 No-Fluff Tone
- No compliments, no filler. 
- Use neutral, direct phrasing.

### 13.4 Deep Diagnosis Before Code
```
Problem: …
Cause: …
Evidence: …
Fix: …
Result: …

- **Hard rule:** Never suggest coordinate fixes or transforms **without** naming the spaces involved and expected result space.
```

### 13.5 Code-Emission Rules
- No speculative code. 
- Provide minimal testable patch + assertions + rollback.

### 13.6 Decision Gate (with Prototype Exception)
Cursor writes code only if at least one of these is true: 
1. A reproducible failure is described, 
2. A concrete feature delta is defined (inputs/outputs), 
3. A targeted refactor has clear acceptance criteria. 

**Prototype Exception:** 
Exploratory coding is permitted *only* when the goal is to clarify or diagnose a problem, not to finalize behavior. 
In that case: 
- Label the output explicitly as `prototype`, 
- Limit scope to minimal testable behavior, 
- Include a `## Findings` section summarizing what was learned, 
- No permanent changes until validated. 

### 13.7 Acceptance Criteria
List 3–5 criteria before implementing. 
Proceed only after they exist. 

### 13.8 Default Output Order
1. Summary 
2. Diagnostic/Recommendation 
3. Next Step 
4. *(Optional)* Patch + Test + Rollback 

---

## 14. GitHub Governance & Automation (CLI-First)

### 14.1 Versioning Policy
- Use Semantic Versioning. 
- **Major** bump → breaking change or coordinate-system shift. 
- Each major version must have **stand-alone URLs**: 
 - `.../tree/vX.0.0` 
 - `.../releases/tag/vX.0.0` 
 - raw permalink 
 - demo (if Pages) 
- Log these under `DECISIONS.md` → “Release Links” and `PROJECT_OVERVIEW.md`.

### 14.2 Commit & Branch Discipline
As defined in §5. 

### 14.3 CLI Workflows
Use **GitHub CLI (`gh`)** exclusively for releases, PRs, and uploads.

#### Major Release Example
```bash
git pull --rebase
echo "X.0.0" > VERSION
git commit -am "chore(release): vX.0.0 — major"
git tag -a vX.0.0 -m "Release vX.0.0"
git push origin vX.0.0
gh release create vX.0.0 --generate-notes --title "vX.0.0" --latest
REPO=$(gh repo view --json url -q .url)
echo "Tree: ${REPO}/tree/vX.0.0"
echo "Release: ${REPO}/releases/tag/vX.0.0"
```

#### Minor/Patch
Same flow with adjusted tag.

#### PR Creation
```bash
gh pr create --fill --title "feat: ..." --body "See PERFORMANCE_LOG.md for benchmarks."
```

#### Attach Artifacts
```bash
gh release upload vX.Y.Z dist/app.zip reports/perf_vX.Y.Z.json --clobber
```

### 14.4 Stand-Alone URL Rule (Mandatory for MAJOR)
After tagging → add links to `PROJECT_OVERVIEW.md` and `DECISIONS.md`.

### 14.5 Automation Checklist
- [ ] Tests pass 
- [ ] Lint clean 
- [ ] `COORDINATE_CONVENTIONS.md` validated 
- [ ] `PERFORMANCE_LOG.md` updated 
- [ ] Demo verified 

### 14.6 Rollback Plan
```bash
git tag -d vX.0.0
git push --delete origin vX.0.0
gh release delete vX.0.0 --yes
```

### 14.7 Required Output (Cursor)
```
Summary: vX.0.0 released
Links:
- Tree: …
- Release: …
- Raw: …
Next:
- Tag demo build and post to PROJECT_OVERVIEW.md
```

