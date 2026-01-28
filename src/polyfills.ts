import { Buffer } from 'buffer';

window.Buffer = Buffer;
window.global = window;
window.process = {
  env: { NODE_ENV: 'development' },
  version: '',
  nextTick: (cb: any) => setTimeout(cb, 0),
} as any;
