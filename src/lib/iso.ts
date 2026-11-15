export const TILE_W = 48;
export const TILE_H = 24;
export const TILE_Z = 40;

export function project(x: number, y: number, z: number, angle: number) {
  const rad = (angle * Math.PI) / 180;
  const rx = x * Math.cos(rad) - y * Math.sin(rad);
  const ry = x * Math.sin(rad) + y * Math.cos(rad);
  
  const screenX = (rx - ry) * (TILE_W / 2);
  const screenY = (rx + ry) * (TILE_H / 2) - z * TILE_Z;
  return { x: screenX, y: screenY };
}

export function getBoxFaces(x: number, y: number, z: number, angle: number, w = 1, h = 1, d = 1) {
  const p = (px: number, py: number, pz: number) => project(px, py, pz, angle);
  
  const top = [
    p(x, y, z+d), p(x+w, y, z+d), p(x+w, y+h, z+d), p(x, y+h, z+d)
  ];
  const left = [
    p(x, y+h, z), p(x, y+h, z+d), p(x+w, y+h, z+d), p(x+w, y+h, z)
  ];
  const right = [
    p(x+w, y, z), p(x+w, y+h, z), p(x+w, y+h, z+d), p(x+w, y, z+d)
  ];
  
  return { top, left, right };
}

// НОВОЕ: Грани для двускатной крыши
export function getRoofFaces(x: number, y: number, z: number, angle: number) {
  const p = (px: number, py: number, pz: number) => project(px, py, pz, angle);
  const roofH = 0.8; // Высота конька крыши

  // Левая сторона крыши (скат)
  const roofLeft = [
    p(x, y, z), p(x, y+1, z), p(x+0.5, y+1, z+roofH), p(x+0.5, y, z+roofH)
  ];
  // Правая сторона крыши (скат)
  const roofRight = [
    p(x+1, y, z), p(x+1, y+1, z), p(x+0.5, y+1, z+roofH), p(x+0.5, y, z+roofH)
  ];
  // Фронтон (треугольник спереди)
  const roofFront = [
    p(x, y+1, z), p(x+1, y+1, z), p(x+0.5, y+1, z+roofH)
  ];

  return { roofLeft, roofRight, roofFront };
}

export function getDepth(x: number, y: number, z: number, angle: number) {
  const rad = (angle * Math.PI) / 180;
  const rx = x * Math.cos(rad) - y * Math.sin(rad);
  const ry = x * Math.sin(rad) + y * Math.cos(rad);
  return rx + ry + z;
}
// Обратная проекция: экран -> координаты сетки (для перетаскивания)
export function unproject(screenX: number, screenY: number, angle: number) {
  const rad = (angle * Math.PI) / 180;
  
  // 1. Убираем изометрический сдвиг (z=0 для пола)
  const isoX = screenX / (TILE_W / 2);
  const isoY = screenY / (TILE_H / 2);
  
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