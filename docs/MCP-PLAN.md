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

## Architecture (proposed; confirmed in Phase 1)

**A, with an Editor in Node.**

- The Node MCP server owns an `Editor` instance in-process (no DOM), so authoring tools are
  synchronous, cheap and undoable.
- For preview and export it lazily starts the existing Python service (which also serves the
  app's static files) and one headless Chromium page on that origin. The page imports
  `src/export-frame-renderer.mjs` only, receives the document, and returns PNG frames.
- Node pipes the frames into the system `ffmpeg` (mp4, webm, gif) or writes PNGs to disk.
  Contact sheets are composed in the page with Canvas 2D.
- `.piv`/`.stk`/`.styk` open and save go through the same Python service.

Why not B (drive the whole editor UI)? It boots the full app (more failure modes) and
every edit would cross the browser bridge. Export needs no GPU, so A needs only the parts
that rasterize.
