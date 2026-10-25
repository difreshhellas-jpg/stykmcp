// Easing names accepted by the MCP tools: the app's own registry, minus Bezier
// (which needs control points the tools do not expose).
import {EASING_MODES as APP_MODES} from '../../src/keyframe-easing.mjs';

const ids = APP_MODES.map(mode => typeof mode === 'string' ? mode : mode.id ?? mode.value);
export const EASING_MODES = Object.freeze(ids.filter(id => id && id !== 'bezier'));
