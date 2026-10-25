# StykMCP plan

StykMCP is an independent fork of [StykAnimate](https://github.com/filippocalippo/StykAnimate-App)
(GPL-3.0-or-later). It is not endorsed by the original author. This file records
what the code actually does (verified against upstream `main` at `def97214`) and
how the MCP server builds on it.

## Phase 0 findings

### Environment (cloud dev container)

| Prerequisite | Found | Note |
| --- | --- | --- |
| Node | 22.22.0 | Upstream CI/releases use 24.11.0. One unit test (`localization-catalogs.test.mjs`, plural form *order*) fails on Node 22's ICU; it is not caused by this fork. |
| Python | 3.13 | Backend needs 3.10+; CI uses 3.12.9. `backend/requirements-fast.txt` is optional. |
| ffmpeg / ffprobe | 6.1.1 | Only the MCP server needs them on PATH. The desktop app bundles its own encoder. |
| Chromium | Playwright 1.63 (devDependency) | Used headlessly for rendering only. |

Baseline: `npm run check` passes; `npm test` gives 3772 pass, 1 fail (the
ICU case above), 25 skipped; `python -m unittest discover -s backend -p "test_*.py"`
gives 155 OK, 45 skipped. `npm run serve` serves the editor at `http://127.0.0.1:47831`, and
it boots in headless Chromium (`window.styk.ready === true`).

### Document model (`src/demo.mjs`, `src/pivot/`, `src/startup-document.mjs`)

A document ("report") is plain JSON in the Pivot codec schema:

- `canvas_width`, `canvas_height`, `fps`, `version: 5`, `backgrounds[]`.
- `figure_types[]`: figure definitions. Each has `segments[]` forming a tree:
  `segment_id`, `parent_id` (0 = the figure origin), `length`, `angle_rad`,
  `thickness`, `color_rgb`, `segment_kind` (`line`, `circle`, `circleFill`, …),
  optional `name` (the startup figure "Blue" names its ten joints: Torso, Head,
  Left upper arm, …).
- `keyframes[]`: frames. Each has `duration_raw` (ticks it occupies; one tick is one
  output frame at `fps`), a `camera` `{x, y, scale, angle_rad}`, `objects[]` (pose
  instances: `unique_id`, `figure_type_id`, `root_x`, `root_y`, `scale`, `angles[]`
  with one **absolute world angle per segment**, optional `lengths`, `_stykIK`) and draw order.
  Interpolation from one keyframe to the next comes from `frame._styk.easing.interpolation`
  (`constant`, `linear`, `auto`, `easeIn`, `easeOut`, `bezier`; see `docs/keyframe-easing.md`).
- `_styk`: StykAnimate extensions. `layers` (user layers), optionally `layerSheet`
  (the Advanced timeline's per-layer exposure grid; when present `evaluatedFrame`
  samples it instead of the plain keyframe list), `animation.channels` (property
  keys), `cameraMotion.clips` (Follow, Shake, Handheld, Wobble, Impact punch, Zoom pulse),
  `vfxClips.clips` plus per-object VFX stacks (`VFX_REGISTRY`: glow, blur, shockwave,
  particles, explosion, smoke, …).

The plain keyframe list (no `layerSheet`) is a complete, supported model: `emptyDocument()`
and `createDemo()` produce it, and the renderer, exporter and Pivot writers accept it.
The MCP server authors that model, so one keyframe is one pose of every figure, which
fits tool calls well.

### Commands and undo (`src/editor.mjs` + `src/editor-*.mjs`)

`new Editor({demo:false})` is a DOM-free `EventTarget` and runs in plain Node; about 40
unit-test files already construct it there. Mutations go through methods
(`addFigure`, `addFrame`, `duplicateFrame`, `deleteFrames`, `updateObject`,
`setFrameDuration`, `setCanvasSize`, `setBackgroundColor`, `setCameraValues`,
`addCameraMotion`, `addVfx`, `setNodeIK`, `poseIKTarget`, …). Each one records a command
through `_record` (bounded by `historyLimit`/`historyBytes`), and `undo()`/`redo()` replay
them. `editor.load(document)` replaces the document and `editor.report` is the live document.
Selection (`select(uid, joint)`, `selectFrame(i)`) is the implicit target of many commands.

### IK (`src/ik.mjs`, `src/editor-ik.mjs`)

IK is per pose instance (`object._stykIK` keyed by endpoint handle id). `setNodeIK` enables
or configures it on the selected joint, and `poseIKTarget` moves a target. The solve happens
during geometry evaluation (`buildGeometry`), so render and export see the result. PIV export
bakes IK into plain angles. For `ik_reach` the MCP server can also run a direct two-bone
analytic solve and write absolute angles. That keeps documents simple and Pivot-compatible.

### Saving

- Native `.styk` / `.stkz`: compressed sectioned containers (`docs/native-file-format.md`),
  written by `DocumentExporter` in a worker or by the Python service.
- Pivot `.piv` / `.stk`: written only by the Python codec (`backend/server.py`,
  `POST /api/export {document, format}`), which also decodes them (`POST /api/import`).
  `desktop/backend.cjs#startBackend` (used by `npm run serve`) starts that service on loopback.
- The service also accepts plain `.json` documents as native projects.

### Export, end to end

1. `export-flow.mjs` builds a request (`export-request.mjs#exportJob`): size, start/end tick, fps.
2. `ExportFrameRenderer` (`export-frame-renderer.mjs`) streams the document to
   `export-frame-worker.mjs`, which evaluates each tick and rasterizes it with **Canvas 2D
   on OffscreenCanvas** (`export-frame-core.mjs#drawExportScene`). Export does **not** use WebGPU.
3. Output frame *i* is `renderNativeTick(start + i)`, which returns a PNG Blob.
4. Desktop: `native-video-export.mjs` streams those PNGs through the `stykDesktop` IPC into the
   bundled FFmpeg (MP4 H.264, WebM VP9 with alpha, AVI, WMV). Browser: WebCodecs plus local muxers.
   GIF and PNG sequences use `image-export.mjs` in an encoding worker.

WebGPU is used only by the interactive editor canvas (`renderer.mjs`), which has its own
"Canvas 2D fallback".

### Telemetry

Telemetry is consent-gated and travels only through the Electron desktop bridge
(`DesktopTelemetryClient` → `stykDesktop` IPC → `desktop/telemetry.cjs`). The headless page
the MCP server uses loads neither `app.mjs` nor the desktop bridge, so it cannot send anything.
As a second guard, the MCP browser context aborts every request that is not to its own loopback origin.

## Phase 1: headless feasibility (verified)

| Question | Result |
| --- | --- |
| Document model and commands in plain Node, no DOM? | Yes. `new Editor({demo:false})`, `load()`, `evaluatedFrame`, `buildGeometry`, the validators, camera-motion and VFX factories all run in Node. |
| Renderer/exporter in headless Chromium? | Yes. A minimal page imports `src/export-frame-renderer.mjs`; its worker rasterizes with Canvas 2D on OffscreenCanvas. It works with `--disable-gpu`, so no WebGPU, Vulkan, ANGLE or SwiftShader flags are needed. (The full editor also boots headless; with `--enable-unsafe-webgpu --use-angle=swiftshader --use-vulkan=swiftshader` it gets a software adapter and switches to its compatibility renderer.) |
| Non-WebGPU render path? | Export itself is the CPU path: Canvas 2D for PNG/video frames, `svg-export.mjs` for SVG. Previews use the same path. |
| How does MP4/GIF export work, and can it be called? | `renderNativeTick(tick)` returns one PNG Blob per output frame (one tick = one frame). The desktop app pipes these through IPC to its bundled FFmpeg; the browser uses WebCodecs plus local muxers. The MCP server pipes the same PNGs into the system `ffmpeg` (H.264 MP4, VP9 WebM with alpha, palette GIF). |
| Saving and opening? | `DocumentExporter` in the page writes `.styk` (built in its worker) and `.piv`/`.stk` (through the codec service's `POST /api/export`, after the app's own Pivot materialization). Node opens files with `POST /api/import`. |

Spike evidence (this container): a 13-frame 640x360 clip rendered in about 0.5 s, encoded to H.264,
and ffprobe reported `640x360, 24/1, 13 frames, 0.5417 s`. `.piv` (291 bytes), `.styk` (1.5 KB) and
`.stk` round trips reopened with matching content. Tick-by-tick pixel centroids matched `evaluatedFrame`.

## Architecture (chosen)

**A: the Node MCP server owns the document, and a headless browser page only rasterizes and saves.**

```
Claude ──stdio──> mcp/server.mjs ── tools.mjs (zod schemas, batch)
                                     └─ studio.mjs: Editor (Node, no DOM) + snapshot undo
                                          ├─ figures.mjs / moves.mjs: presets, FK, IK, preset moves
                                          └─ render-host.mjs ──> codec service (backend/server.py, loopback + token)
                                                              └─> headless Chromium: mcp/render/page.mjs
                                                                   (ExportFrameRenderer, DocumentExporter)
                                     encode.mjs ──> system ffmpeg (mp4, webm, gif)
```

Why A rather than B (driving the whole editor UI through `window.__stykMcp`)? Authoring is plain
data plus the app's evaluator, so it runs in Node at about 1–20 ms per tool call and has no UI or GPU
failure modes. The browser starts lazily, only for pixels and native saves, and loads two modules
rather than the app shell, so telemetry, update checks and the GPU are never involved. B would boot
the full editor (WebGPU startup, panels, autosave and recovery) and push every edit across a bridge.

Decisions:

- **Timeline model.** The tools author the plain keyframe list (Simple timeline), with no layer sheet.
  Pivot keys are global, so the tool layer marks the keys each tool authored per figure
  (`object._mcpKey`) and for the camera (`frame._styk.mcpCamera`). After every edit it re-derives the
  other keys from their authored neighbours using the outgoing key's easing (`easedProgress`). Channels
  therefore never freeze each other, and the file stays an ordinary Pivot-compatible document.
- **Undo.** One snapshot per tool call (and per `batch`), bounded to 60. The editor's own
  frame-scoped history is not used for these whole-document operations.
- **Validation.** zod at the tool boundary; `validateScene`, `validateVfxClips` and
  `validateCameraMotion` plus `Editor.load` after every operation. Failures roll back and return one
  actionable sentence; batch errors include the expected signature.
- **Pose convention.** Absolute bone directions in degrees (0 down, 90 right). Moves place each key
  with forward kinematics so the lowest joint stays on the ground; FK is checked against `buildGeometry`.
- **Fallbacks.** No Python: a small Node static host (`mcp/lib/static-server.mjs`) serves the page, and only `.styk/.piv/.stk`
  are unavailable. No ffmpeg: PNG sequences still export. Browser: Playwright Chromium, then Edge, then Chrome.

## Phase 3: verification

| Check | Command | Result (this container) |
| --- | --- | --- |
| Tool-layer unit tests | `npm run test:mcp` (also part of `npm test`) | 18 pass |
| MCP over stdio: 2-second jump to MP4, `.piv` round trip, 3-second jump kick | `npm run test:mcp:smoke` | pass; ffprobe `640x360, 24 fps, 48 frames, 2.0 s` and `960x540, 24 fps, 72 frames, 3.0 s`; GIF `480x270, 12 fps, 24 frames` |
| Existing checks | `npm run check`, `npm test`, Python unittest | pass, except one pre-existing Node 22/ICU plural-order test (fails identically without this fork) |
| Claude Code registration | `claude mcp add stykmcp -- node …/mcp/server.mjs`, then `claude mcp list` | `stykmcp … √ Connected` |
| Real agent, prompt "3-second jump kick with camera punch-in, export MP4" | `claude -p … --model sonnet` | 2 server calls (`help basics`, then one `batch` ending with `export`), 2,723 chars of tool output, valid 3.0 s MP4 (960x540, 24 fps, 72 frames). An earlier version without signatures in `help` took 6 calls, 2 of them failed batches |

Token cost, measured by the smoke test (characters of tool output):

| Workload | Calls | Text output | Images |
| --- | --- | --- | --- |
| 2-second jump: batch, describe, preview, export, undo | 5 | 688 chars | one 480 px contact sheet |
| 3-second jump kick: help basics, help moves, batch with export, preview | 4 | 4,024 chars (help is 3,672 of it) | one 640 px contact sheet |
| Real agent run: help basics, batch with export | 2 | 2,723 chars | none |
| Tool list (sent once per session) | – | about 13,400 chars for 22 tools | – |

A contact sheet is billed as image tokens by its pixel size (a 640x~330 sheet is roughly 300
tokens), not by its base64 length.
