// Video/GIF encoding with the system ffmpeg; PNG sequences are written directly.
import {spawn, execFile} from 'node:child_process';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

const FFMPEG = () => process.env.STYKMCP_FFMPEG || 'ffmpeg';
const FFPROBE = () => process.env.STYKMCP_FFPROBE || 'ffprobe';
const missing = tool => new Error(`${tool} was not found. Install ffmpeg (Windows: winget install Gyan.FFmpeg; Linux: apt install ffmpeg), open a new terminal, or set STYKMCP_FFMPEG/STYKMCP_FFPROBE to its full path.`);

const even = 'pad=ceil(iw/2)*2:ceil(ih/2)*2';
const ARGS = {
  mp4: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-vf', even, '-movflags', '+faststart'],
  webm: ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '32', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', '-pix_fmt', 'yuva420p'],
  gif: ['-filter_complex', 'split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5', '-loop', '0'],
};
export const VIDEO_FORMATS = Object.keys(ARGS);

/** Stream PNG frames (async iterable of Buffers) into ffmpeg. */
export function encodeVideo({format, file, fps, frames}) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG(), ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-', ...ARGS[format], file],
      {stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true});
    let stderr = '', failed = false;
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', error => { failed = true; reject(error.code === 'ENOENT' ? missing('ffmpeg') : error); });
    child.on('close', code => { if (!failed) code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${stderr.trim().split('\n').slice(-3).join(' ')}`)); });
    child.stdin.on('error', () => {});
    (async () => {
      for await (const frame of frames) if (!child.stdin.write(frame)) await new Promise(r => child.stdin.once('drain', r));
      child.stdin.end();
    })().catch(error => { child.kill(); reject(error); });
  });
}

export async function writeSequence({dir, frames, prefix = 'frame'}) {
  await mkdir(dir, {recursive: true});
  let index = 0;
  for await (const frame of frames) await writeFile(path.join(dir, `${prefix}_${String(++index).padStart(4, '0')}.png`), frame);
  return index;
}

/** Duration, fps and size of a video file. */
export function probe(file) {
  return new Promise((resolve, reject) => {
    execFile(FFPROBE(), ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=width,height,r_frame_rate,nb_read_frames:format=duration', '-of', 'json', file],
      {windowsHide: true}, (error, stdout) => {
        if (error) return reject(error.code === 'ENOENT' ? missing('ffprobe') : error);
        const data = JSON.parse(stdout), stream = data.streams?.[0] ?? {};
        const [n, d] = String(stream.r_frame_rate ?? '0/1').split('/').map(Number);
        resolve({width: stream.width, height: stream.height, fps: d ? n / d : 0, frames: Number(stream.nb_read_frames), duration: Number(data.format?.duration)});
      });
  });
}
