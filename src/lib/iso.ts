export const TILE_W = 48;
export const TILE_H = 24;
export const TILE_Z = 40;

// Проекция 3D -> 2D (добавлен параметр tilt для наклона камеры)
export function project(x: number, y: number, z: number, angle: number, tilt: number = 1) {
  const rad = (angle * Math.PI) / 180;
  const rx = x * Math.cos(rad) - y * Math.sin(rad);
  const ry = x * Math.sin(rad) + y * Math.cos(rad);
  
  const screenX = (rx - ry) * (TILE_W / 2);
  // tilt влияет на вертикальное сжатие (чем меньше, тем ближе к виду сверху)
  const screenY = (rx + ry) * (TILE_H / 2) * tilt - z * TILE_Z;
  return { x: screenX, y: screenY };
}

// Обратная проекция: экран -> координаты сетки (добавлен tilt)
export function unproject(screenX: number, screenY: number, angle: number, tilt: number = 1) {
  const rad = (angle * Math.PI) / 180;
  
  // 1. Убираем изометрический сдвиг (z=0 для пола)
  const isoX = screenX / (TILE_W / 2);
  const isoY = screenY / ((TILE_H / 2) * tilt);
  
  // 2. Находим координаты до поворота
  const rx = (isoX + isoY) / 2;
  const ry = (isoY - isoX) / 2;
  
  // 3. Обратный поворот (на -angle)
  const cos = Math.cos(-rad);
  const sin = Math.sin(-rad);
  const x = rx * cos - ry * sin;
  const y = rx * sin + ry * cos;
  
  return { x, y };
}

// Определение глубины для правильной отрисовки (Painter's Algorithm)
export function getDepth(x: number, y: number, z: number, angle: number) {
  const rad = (angle * Math.PI) / 180;
  const rx = x * Math.cos(rad) - y * Math.sin(rad);
  const ry = x * Math.sin(rad) + y * Math.cos(rad);
  return rx + ry + z;
}

// Дополнительные функции для кубов (если они где-то понадобятся в будущем)
export function getBoxFaces(x: number, y: number, z: number, angle: number, w = 1, h = 1, d = 1) {
  const p = (px: number, py: number, pz: number) => project(px, py, pz, angle);
  const top = [p(x, y, z+d), p(x+w, y, z+d), p(x+w, y+h, z+d), p(x, y+h, z+d)];
  const left = [p(x, y+h, z), p(x, y+h, z+d), p(x+w, y+h, z+d), p(x+w, y+h, z)];
  const right = [p(x+w, y, z), p(x+w, y+h, z), p(x+w, y+h, z+d), p(x+w, y, z+d)];
  return { top, left, right };
}

export function getRoofFaces(x: number, y: number, z: number, angle: number) {
  const p = (px: number, py: number, pz: number) => project(px, py, pz, angle);
  const roofH = 0.8;
  const roofLeft = [p(x, y, z), p(x, y+1, z), p(x+0.5, y+1, z+roofH), p(x+0.5, y, z+roofH)];
  const roofRight = [p(x+1, y, z), p(x+1, y+1, z), p(x+0.5, y+1, z+roofH), p(x+0.5, y, z+roofH)];
  const roofFront = [p(x, y+1, z), p(x+1, y+1, z), p(x+0.5, y+1, z+roofH)];
  return { roofLeft, roofRight, roofFront };
}