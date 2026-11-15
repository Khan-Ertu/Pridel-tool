import type { Palette, StyleProfile } from "../types";

// Бумага, маркер, крафт, металл, синий, жёлтый.
export const PAPER_PALETTE: Palette = {
  name: "Бумага и маркер",
  background: "#e9e6df",
  outline: "#141414",
  accent: "#f4d03f",
  colors: [
    "#e9e6df", // бумага
    "#d6cfc0", // тёплый серый
    "#c0a577", // крафт
    "#8a8a8a", // металл
    "#2e6fbf", // синий маркер
    "#f4d03f", // выделительный жёлтый
    "#b7b0a3", // светлая бумага
  ],
};

// Яркий плоский патчворк (второй референс).
export const COLOR_PALETTE: Palette = {
  name: "Цветной патчворк",
  background: "#5c7a7a",
  outline: "#0a0a0a",
  accent: "#f4d03f",
  colors: [
    "#f4d03f",
    "#4ecdc4",
    "#ff6b9d",
    "#6c5ce7",
    "#ffa552",
    "#a8e6cf",
    "#c39bd3",
    "#2d98da",
    "#f8f9fa",
    "#1a1a1a",
  ],
};

export const PAPER_STYLE: StyleProfile = {
  mode: "paper",
  palette: PAPER_PALETTE,
  depthDx: 10,
  depthDy: -6,
};

export const COLOR_STYLE: StyleProfile = {
  mode: "color",
  palette: COLOR_PALETTE,
  depthDx: 12,
  depthDy: -7,
};