export const TILE_W = 48;
export const TILE_H = 24;
export const TILE_Z = 40;

export function project(x: number, y: number, z: number, angle: number, tilt: number = 1) {
  const rad = (angle * Math.PI) / 180;
  const rx = x * Math.cos(rad) - y * Math.sin(rad);
  const ry = x * Math.sin(rad) + y * Math.cos(rad);
  
  const screenX = (rx - ry) * (TILE_W / 2);
  // Защита от растяжения: не даем наклону опуститься ниже 0.5.
  // При 0.5 масштаб Y равен масштабу X, что дает квадратные тайлы.
  const safeTilt = Math.max(0.5, tilt);
  const screenY = (rx + ry) * (TILE_H / 2) / safeTilt - z * TILE_Z;
  
  return { x: screenX, y: screenY };
}

export function unproject(screenX: number, screenY: number, angle: number, tilt: number = 1) {
  const rad = (angle * Math.PI) / 180;
  
  const isoX = screenX / (TILE_W / 2);
  const safeTilt = Math.max(0.5, tilt);
  const isoY = (screenY / (TILE_H / 2)) * safeTilt;
  
  const rx = (isoX + isoY) / 2;
  const ry = (isoY - isoX) / 2;
  
  const cos = Math.cos(-rad);
  const sin = Math.sin(-rad);
  const x = rx * cos - ry * sin;
  const y = rx * sin + ry * cos;
  
  return { x, y };
}

export function getDepth(x: number, y: number, z: number, angle: number) {
  const rad = (angle * Math.PI) / 180;
  const rx = x * Math.cos(rad) - y * Math.sin(rad);
  const ry = x * Math.sin(rad) + y * Math.cos(rad);
  return rx + ry + z;
}