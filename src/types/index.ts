export interface Palette {
  top: string;
  left: string;
  right: string;
  window: string;
  outline: string;
}

export interface District {
  id: string;
  x: number;
  y: number;
  height: number;
  roofStyle: "flat" | "pitched";
  colorOverride?: Palette; // <--- ОБЯЗАТЕЛЬНО ДОЛЖНО БЫТЬ ЗДЕСЬ
}