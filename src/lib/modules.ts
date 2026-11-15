import type { Cell, Module, Pt, Polygon, StyleProfile } from "../types";
import type { Rng } from "./rng";

function darken(hex: string, amount: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const k = 1 - amount;
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(c * k))).toString(16).padStart(2, "0");
  return "#" + f(r) + f(g) + f(b);
}

export function generateModulesForCell(
  cell: Cell,
  style: StyleProfile,
  rng: Rng
): Module[] {
  const modules: Module[] = [];
  const { colors } = style;
  const poly = cell.polygon;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of poly) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  // 1. ОКНА (сетка на фасаде)
  if (cell.type !== "void" && cell.type !== "roof") {
    const w = maxX - minX;
    const h = maxY - minY;
    
    const cols = cell.type === "windowCluster" ? rng.int(3, 5) : rng.int(1, 3);
    const rows = Math.max(1, Math.floor(h / 40));

    if (w > 30 && h > 30) {
      const stepX = w / (cols + 1);
      const stepY = h / (rows + 1);

      for (let c = 1; c <= cols; c++) {
        for (let r = 1; r <= rows; r++) {
          if (rng.chance(0.2)) continue;
          const cx = minX + stepX * c;
          const cy = minY + stepY * r;
          const ww = stepX * 0.4;
          const wh = stepY * 0.5;

          modules.push({
            id: `win-${cell.id}-${c}-${r}`,
            type: "window",
            polygon: [
              [cx - ww/2, cy - wh/2],
              [cx + ww/2, cy - wh/2],
              [cx + ww/2, cy + wh/2],
              [cx - ww/2, cy + wh/2],
            ],
            fill: rng.chance(0.15) ? "#f4d03f" : darken(colors.shadow, 0.2), // Светящиеся или тёмные окна
            stroke: colors.outline,
            strokeWidth: 1,
            z: 1,
          });
        }
      }
    }
  }

  return modules;
}