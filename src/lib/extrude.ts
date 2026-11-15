import type { Cell, Polygon, Pt, StyleProfile } from "../types";
import { generateModulesForCell } from "./modules";
import { makeRng } from "./rng";

export type LayerKind = "back" | "side" | "front" | "module";

export interface ExtrusionLayer {
  kind: LayerKind;
  polygon: Polygon;
  fill: string;
  stroke: string;
  strokeWidth: number;
}

export interface ExtrudedShape {
  cellId: string;
  layers: ExtrusionLayer[];
  sortKey: number;
  clipPolygon: Polygon; 
}

function signedArea(poly: Polygon): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

function ensurePositive(poly: Polygon): Polygon {
  return signedArea(poly) >= 0 ? poly : [...poly].reverse();
}

function centroidY(poly: Polygon): number {
  let y = 0;
  for (const [, py] of poly) y += py;
  return y / poly.length;
}

function offsetPolygon(poly: Polygon, dx: number, dy: number): Polygon {
  return poly.map(([x, y]) => [x + dx, y + dy] as Pt);
}

export function extrudeCells(
  cells: Cell[],
  style: StyleProfile,
  seed: string
): ExtrudedShape[] {
  const { colors, annexColors, lightAngle, thickness } = style;
  const shapes: ExtrudedShape[] = [];
  const moduleRng = makeRng(seed + "-modules");

  const rad = (lightAngle * Math.PI) / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);
  
  const BASE_DEPTH = 30;

  for (const cell of cells) {
    if (cell.depth <= 0) continue;

    const poly = ensurePositive(cell.polygon);
    const n = poly.length;

    const isAnnex = cell.type === "annex";
    const themeColors = isAnnex ? annexColors : colors;

    const depth = cell.depth * BASE_DEPTH * thickness; 
    const dx = cosA * depth;
    const dy = sinA * depth;

    const back = offsetPolygon(poly, dx, dy);
    const layers: ExtrusionLayer[] = [];

    layers.push({
      kind: "back",
      polygon: back,
      fill: themeColors.shadow,
      stroke: colors.outline,
      strokeWidth: 1,
    });

    for (let i = 0; i < n; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % n];
      const ex = b[0] - a[0];
      const ey = b[1] - a[1];
      const nx = ey;
      const ny = -ex;
      const dot = nx * dx + ny * dy;
      
      if (dot <= 0) continue;

      const a2: Pt = [a[0] + dx, a[1] + dy];
      const b2: Pt = [b[0] + dx, b[1] + dy];

      const lightDot = nx * cosA + ny * sinA;
      const isLight = lightDot > 0;

      layers.push({
        kind: "side",
        polygon: [a, b, b2, a2],
        fill: isLight ? themeColors.light : themeColors.mid,
        stroke: colors.outline,
        strokeWidth: 1,
      });
    }

    layers.push({
      kind: "front",
      polygon: poly,
      fill: themeColors.mid,
      stroke: colors.outline,
      strokeWidth: 1.2,
    });

    const modules = generateModulesForCell(cell, style, moduleRng);
    for (const mod of modules) {
      layers.push({
        kind: "module",
        polygon: mod.polygon,
        fill: mod.fill,
        stroke: mod.stroke,
        strokeWidth: mod.strokeWidth,
      });
    }

    shapes.push({
      cellId: cell.id,
      layers,
      sortKey: centroidY(poly),
      clipPolygon: poly 
    });
  }

  shapes.sort((a, b) => a.sortKey - b.sortKey);
  return shapes;
}