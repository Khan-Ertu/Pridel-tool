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
}

// НОВОЕ: Ручной блок
export interface ManualBlock {
  id: string;
  x: number;
  y: number;
  z: number; // Высота над землей (0 - пол)
  h: number; // Высота самого блока
}