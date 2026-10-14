export * from './activity.js';
export * from './agent.js';
export * from './control.js';
export * from './defaults.js';
export * from './device.js';
export * from './events.js';
export * from './schemas.js';
export * from './settings.js';
export * from './workflow.js';
export * from './version.js';

export const APP_NAME = 'iPhone AI';
export const API_PREFIX = '/api';
export const WS_PATH = '/ws';
/** Binary live-frame WebSocket (ScreenCaptureKit JPEG frames); see LiveFrameHeader. */
export const WS_SCREEN_PATH = '/ws/screen';
export const SESSION_COOKIE = 'iai_session';
/** Header every state-changing request must carry (CSRF defence in addition to SameSite cookies). */
export const CSRF_HEADER = 'x-iphone-ai';
