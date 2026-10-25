# StykMCP: animate with an AI agent

StykMCP is an [MCP](https://modelcontextprotocol.io) server (stdio) that lets an AI agent such as
Claude create, edit, preview and export stick-figure animations through a few compact tools. It
uses the StykAnimate engine headlessly: no editor window, no screenshots, no large JSON dumps.

> StykMCP is an independent fork of [StykAnimate](https://github.com/filippocalippo/StykAnimate-App)
> (GPL-3.0-or-later). It is not affiliated with or endorsed by the StykAnimate author.

A typical request, "make a 3-second clip of a stick figure doing a jump kick with a camera punch-in,
export MP4", takes Claude two tool calls (`help`, then one `batch`) and under 3,000 characters of
tool output, and ends with an `.mp4` on disk.

## Install

You need:

| Tool | Version | Windows | Linux |
| --- | --- | --- | --- |
| Node.js | 22 or newer | `winget install OpenJS.NodeJS.LTS` | your package manager or [nodejs.org](https://nodejs.org) |
| Python | 3.11 or newer (3.10 works) | `winget install Python.Python.3.12` | `sudo apt install python3` |
| ffmpeg + ffprobe | any recent | `winget install Gyan.FFmpeg` | `sudo apt install ffmpeg` |
| A Chromium browser | Playwright's, or Edge/Chrome | Edge is already installed | `npx playwright install chromium` |

Open a **new** terminal after installing so `PATH` updates, then, from the repository folder:

```sh
npm ci
npx playwright install chromium     # optional on Windows (Edge is used if this is missing)
npm run test:mcp                     # unit tests, no browser needed
npm run test:mcp:smoke               # end to end: MP4 + .piv round trip, prints token cost
```

Python is used only for opening and saving `.styk`, `.piv` and `.stk` files (it runs the app's own
local codec). Previews, MP4/WebM/GIF/PNG export and `.json` saves work without it.

## Run and register

`npm run mcp` starts the server on stdio (it waits for an MCP client; stop it with Ctrl+C).

**Claude Code** (any folder):

```sh
claude mcp add stykmcp -- node "C:\path\to\stykmcp\mcp\server.mjs"      # Windows
claude mcp add stykmcp -- node /path/to/stykmcp/mcp/server.mjs          # Linux
claude mcp list                                                         # should show: stykmcp ... Connected
```

Add `--scope user` to make it available in every project. Use `-e STYKMCP_WORKDIR=D:\Animations`
(before `--`) to choose where files go.

**Claude Desktop**: edit `claude_desktop_config.json` (Settings → Developer → Edit Config; on
Windows it is `%APPDATA%\Claude\claude_desktop_config.json`) and restart Claude Desktop:

```json
{
  "mcpServers": {
    "stykmcp": {
      "command": "node",
      "args": ["C:\\Users\\you\\stykmcp\\mcp\\server.mjs"],
      "env": { "STYKMCP_WORKDIR": "C:\\Users\\you\\Videos\\StykMCP" }
    }
  }
}
```

Use double backslashes in JSON paths. If `node` is not found, give its full path, for example
`"command": "C:\\Program Files\\nodejs\\node.exe"`.

### Files and settings

Relative paths in tool calls resolve against `STYKMCP_WORKDIR` (default: `StykMCP` in your home
folder), never the client's working directory. Environment variables:

| Variable | Effect |
| --- | --- |
| `STYKMCP_WORKDIR` | Folder for relative paths (default `~/StykMCP`) |
| `STYKMCP_BROWSER` | `chromium`, `msedge`, `chrome`, or a browser executable path |
| `STYKMCP_FFMPEG`, `STYKMCP_FFPROBE` | Full paths when ffmpeg is not on `PATH` |
| `STYKMCP_NO_CODEC=1` | Never start the Python codec (no `.styk`/`.piv`/`.stk`) |
| `STYKMCP_LOG_SIZES=1` | Log each tool response size to stderr |
| `STYK_PYTHON` | Python interpreter for the codec |

### Privacy

The server makes no network requests. The app's telemetry, diagnostics and update checks live in the
desktop shell, which MCP mode never loads. The headless render page can reach only its own loopback
origin; every other request is aborted. The codec service listens on 127.0.0.1 with a random token.

## How it works

The server owns one animation document in Node, using the app's own document model, loader,
evaluator and validators. Rendering uses one headless browser page that runs the app's export
renderer (Canvas 2D, no GPU needed), so previews and exports match the editor's File → Export.
ffmpeg encodes video and GIF. See [MCP plan](MCP-PLAN.md) for the design and measurements.

Conventions (also in `help basics`):

- Frames are 1-based. One frame is one output frame at the project fps.
- Positions are canvas pixels, y grows down. A stick figure's position is the point between its
  feet when standing.
- Bone angles are absolute directions in degrees: 0 down, 90 right, 180 up, -90 left.
- Stick bones: `torso head arm_l forearm_l arm_r forearm_r thigh_l shin_l thigh_r shin_r`; limbs
  `arm_l arm_r leg_l leg_r`.
- Each tool edit at a frame keys that figure (or the camera) there. Keys are independent per figure
  and for the camera; between keys, values follow the key's easing.
- Every tool call is one undo step. `batch` is one undo step for all its operations and rolls back
  entirely on any error.

## Tools

| Tool | Purpose |
| --- | --- |
| `help(topic)` | `basics` (with every tool signature), `tools`, `moves`, `presets`, `camera`, `effects`, `easing` |
| `project_new(width, height, fps, frames, background, name)` | New empty animation |
| `project_set(...)` | Change size, fps, length, background, name |
| `project_open(path)` | Open `.styk`, `.piv`, `.stk` or `.json` |
| `project_save(path)` | Save `.styk` (editable), `.piv`/`.stk` (Pivot), `.json` |
| `scene_describe(frame, poses)` | Compact text summary: length, keys, figures with anchor and box, camera, fx |
| `figure_add(preset or file, name, x, y, scale, color, size, from, to)` | Presets: `stick`, `stick_thin`, `ball`, `ground`; or import the first figure of a `.stk`/`.stkz`/`.styk` |
| `figure_remove(figure)`, `figure_update(figure, rename, color, order)` | Remove, rename, recolor, front/back |
| `pose_set(figure, frame(s), angles, bend, x, y, dx, dy, scale, turn, flip, ground, easing)` | Key a pose |
| `ik_reach(figure, limb, frame, x, y, bend)` | Put a hand or foot on a point (two-bone IK) |
| `move_apply(figure, move, start, speed, frames, direction, intensity, distance, height, steps, cycles, limb)` | Generate a whole action: `walk run jump punch kick jump_kick fall wave idle crouch`; reports the impact/apex/landing frame |
| `keys(action, frames, to, easing, count)` | `add`, `delete`, `copy`, `easing`, `insert_time`, `remove_time` |
| `camera_set(frame(s), x, y, zoom, rotation, easing, reset)` | Key the camera |
| `camera_fx(preset, start, end, figure, x, y, zoom, ramp, params)` | `punch_in`, `zoom` (keys) or the app's camera moves `shake handheld wobble impact pulse follow` |
| `effect_add(kind, target, start, end, params, fade_in, fade_out)` | The app's effects: glow, outline, shadow, blur, shockwave, particles, explosion, smoke, aura, beam, … |
| `fx_remove(id)` | Remove a camera move or effect (or `all`) |
| `preview(frames or count, width, columns, path)` | One small PNG contact sheet (default 8 frames, 160 px cells) |
| `export(path, format, start, end, fps, width, alpha)` | `mp4`, `webm` (alpha), `gif`, or `png` (folder of frames) |
| `undo(steps)`, `redo(steps)` | Whole tool calls |
| `batch(ops)` | Many of the above in one call: `[{tool, args}]` |

Outputs are short status lines. Only `preview` returns an image; everything else is written to disk
and returns its path.

### Example batch

```json
{"ops": [
  {"tool": "project_new", "args": {"frames": 72}},
  {"tool": "figure_add", "args": {"preset": "ground", "name": "floor", "y": 440}},
  {"tool": "figure_add", "args": {"preset": "stick", "name": "hero", "x": 260, "y": 440}},
  {"tool": "move_apply", "args": {"figure": "hero", "move": "jump_kick", "start": 12}},
  {"tool": "camera_fx", "args": {"preset": "punch_in", "start": 24, "end": 44, "figure": "hero", "zoom": 1.6}},
  {"tool": "camera_fx", "args": {"preset": "impact", "start": 26}},
  {"tool": "export", "args": {"path": "clips/jump-kick.mp4"}}
]}
```

## Example prompts

1. "Make a 3-second clip of a stick figure doing a jump kick with a camera punch-in, export MP4."
2. "Two stick figures, red and blue, face each other. Blue walks in from the left, punches; red falls
   backwards. Add a camera shake on the hit and export a GIF at 480 px wide."
3. "Open `fight.piv`, make the first figure wave for two seconds at the end, and save it as
   `fight-wave.piv` and as `fight-wave.styk`."
4. "A stick figure runs across a dark night scene with a cyan glow, then jumps over a ball; add
   smoke where it lands. Show me a contact sheet before exporting a WebM."
5. "Create a 4-second loop of an idle breathing stick figure, export it as a PNG sequence at 30 fps
   for my video editor."

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `No headless browser could start` | Run `npx playwright install chromium`, or set `STYKMCP_BROWSER=msedge` (Windows) / `chrome`. |
| `ffmpeg was not found` | Install ffmpeg (see Install), open a new terminal/restart Claude, or set `STYKMCP_FFMPEG`/`STYKMCP_FFPROBE`. PNG export still works. |
| `The local codec service ... could not start` | Install Python 3.11+ (`py -3 --version` on Windows) or set `STYK_PYTHON`. Needed only for `.styk/.piv/.stk`. |
| GPU or WebGPU errors | The server never uses the GPU (`--disable-gpu`; export is Canvas 2D). Errors mentioning WebGPU come from the desktop editor, not StykMCP. |
| Claude Desktop shows the server as failed | Check the paths in the JSON (double backslashes), use the full path to `node.exe`, and read the logs (Settings → Developer). The server logs to stderr only. |
| First preview takes a few seconds | The browser and codec start lazily on the first preview/export/save; later calls are fast. |
| Files are not where expected | Relative paths go to `STYKMCP_WORKDIR` (default `~/StykMCP`); tool replies print absolute paths. |

## Known limitations

- Moves (`move_apply`) and `ik_reach` need the two-legged stick topology (`stick`, `stick_thin`, or
  any 10-bone figure built like them). Other figures are posed with `pose_set`.
- Preset moves are side-view poses; they look best facing left or right, not toward the viewer.
- The MCP authors the classic keyframe timeline. Projects using the Advanced timeline's layer sheet
  are flattened into plain keyframes when opened.
- `.piv`/`.stk` cannot store effects, camera motion clips or IK, as in the app itself: saving a
  `.piv` with effects is refused (remove them with `fx_remove` or save `.styk`, which keeps
  everything). Pivot export bakes interpolation into one key per frame.
- Audio, drawing layers, movieclips and text are not exposed as tools.
- One document per server; tool calls run one at a time.
- Rendering uses a software Canvas 2D path: correct, but a 1080p minute takes a while.
- The desktop app in this fork still uses upstream's packaging identity, update feed and interface
  text; only the package name, metadata and icon are renamed.
