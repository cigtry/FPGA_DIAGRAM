export type ThemeName = 'light' | 'dark';

export interface Palette {
  name: ThemeName;
  bg: string;
  grid: string;
  gridMajor: string;
  nodeFill: string;
  nodeFillAlt: string;
  nodeStroke: string;
  text: string;
  textDim: string;
  wire: string;
  bus: string;
  clock: string;
  ctrl: string;
  accent: string;
  noteFill: string;
  noteStroke: string;
  groupStroke: string;
  axis: string;
  band: string;
  title: string;
}

export const LIGHT: Palette = {
  name: 'light',
  bg: '#ffffff',
  grid: '#eef1f4',
  gridMajor: '#e3e8ee',
  nodeFill: '#f7f9fb',
  nodeFillAlt: '#eef3f8',
  nodeStroke: '#5b6b7c',
  text: '#1f2933',
  textDim: '#67788a',
  wire: '#3d4c5c',
  bus: '#12694a',
  clock: '#8a5a12',
  ctrl: '#7a3fa8',
  accent: '#0b6bcb',
  noteFill: '#fffbe8',
  noteStroke: '#c9b458',
  groupStroke: '#9aabbb',
  axis: '#7d8b99',
  band: '#f2f5f8',
  title: '#0f2231',
};

export const DARK: Palette = {
  name: 'dark',
  bg: '#1e1e1e',
  grid: '#282d34',
  gridMajor: '#31373f',
  nodeFill: '#252b33',
  nodeFillAlt: '#2b323b',
  nodeStroke: '#7f8f9f',
  text: '#e6edf3',
  textDim: '#9fb0c0',
  wire: '#a8b8c8',
  bus: '#5fbf94',
  clock: '#e0b055',
  ctrl: '#c39cf0',
  accent: '#4a9eff',
  noteFill: '#33301f',
  noteStroke: '#8a7a3a',
  groupStroke: '#5a6673',
  axis: '#9fb0c0',
  band: '#23282f',
  title: '#e6edf3',
};

export function palette(t: ThemeName | undefined): Palette {
  return t === 'dark' ? DARK : LIGHT;
}

export function edgeColor(p: Palette, style: string): string {
  switch (style) {
    case 'bus':
      return p.bus;
    case 'clock':
      return p.clock;
    case 'ctrl':
      return p.ctrl;
    default:
      return p.wire;
  }
}
