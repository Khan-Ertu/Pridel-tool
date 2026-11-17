import { Delaunay } from "d3-delaunay";
import * as PCModule from "polygon-clipping";
import { project, getDepth } from "./iso";
import type { District, Palette } from "../types";

const PC = (PCModule as typeof PCModule & { default?: typeof PCModule }).default ?? PCModule;
type PCRing = [number, number][];
type PCPoly = PCRing[];
type PCMulti = PCPoly[];

export const ROOF_HEIGHT = 1.5;

type GridBounds = [number, number, number, number];

interface Building {
  district: District;
  polygon: PCRing;
  pieceIdx: number;
}

interface CityFace {
  key: string;
  points: string;
  color: string;
  outline: string;
  depth: number;
  districtId: string;
}

export type CityRenderObject = CityFace & (
  | { type: "wall"; windows: string[]; door: string | null; windowColor: string }
  | { type: "roof"; strokeWidth: number }
);

function shrinkPolygon(poly: [number, number][], amount: number): [number, number][] {
  if (poly.length < 3) return poly;
  const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
  const cy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
  return poly.map(([x, y]) => {
    const dx = x - cx; const dy = y - cy;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) return [cx, cy] as [number, number];
    const t = Math.max(0.05, (len - amount) / len);
    return [cx + dx * t, cy + dy * t] as [number, number];
  });
}

function polygonArea(poly: [number, number][]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i]; const [x2, y2] = poly[(i + 1) % poly.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

function ensureCCW(poly: [number, number][]): [number, number][] {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i]; const [x2, y2] = poly[(i + 1) % poly.length];
    s += x1 * y2 - x2 * y1;
  }
  return s > 0 ? poly : [...poly].reverse();
}

function isPointInPolygon(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function findInsidePoint(poly: [number, number][]): [number, number] {
  const vx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
  const vy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
  if (isPointInPolygon(vx, vy, poly)) return [vx, vy];

  const minX = Math.min(...poly.map(p => p[0]));
  const maxX = Math.max(...poly.map(p => p[0]));
  const minY = Math.min(...poly.map(p => p[1]));
  const maxY = Math.max(...poly.map(p => p[1]));

  let bestX = vx, bestY = vy, bestD = Infinity;
  const N = 15;
  for (let i = 1; i < N; i++) {
    for (let j = 1; j < N; j++) {
      const x = minX + (maxX - minX) * i / N;
      const y = minY + (maxY - minY) * j / N;
      if (!isPointInPolygon(x, y, poly)) continue;
      const d = Math.hypot(x - vx, y - vy);
      if (d < bestD) { bestD = d; bestX = x; bestY = y; }
    }
  }
  return [bestX, bestY];
}

function isConvex(poly: [number, number][]): boolean {
  if (poly.length < 4) return true;
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const c = poly[(i + 2) % poly.length];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 0.0001) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

function getVisibleEdges(poly: [number, number][], angle: number, tilt: number): number[] {
  if (poly.length < 3) return [];
  if (tilt <= 0.55) return [];

  const rad = (angle * Math.PI) / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);

  // Вектор, направленный от сцены к камере (в мировых координатах)
  // Это направление, в котором экранные объекты «приближаются» (двигаются вниз по экрану)
  const camDirX = cosA + sinA;
  const camDirY = cosA - sinA;

  const visible: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];

    // Внешняя нормаль для полигона против часовой стрелки (CCW)
    // (полигон гарантированно CCW — мы применяем ensureCCW перед рендером)
    const nx = ey;
    const ny = -ex;

    // Ребро видимо, если его внешняя нормаль смотрит в сторону камеры
    const dot = nx * camDirX + ny * camDirY;
    if (dot > 0.0001) visible.push(i);
  }

  return visible;
}

function getWindowsOnWall(
  p1: [number, number], p2: [number, number], z1: number, z2: number, angle: number, tilt: number
) {
  const dx = p2[0] - p1[0]; const dy = p2[1] - p1[1];
  const len = Math.hypot(dx, dy);
  const count = Math.max(1, Math.floor(len / 1.5));
  const windows = [];
  const wallP1 = project(p1[0], p1[1], z1, angle, tilt);
  const wallP2 = project(p2[0], p2[1], z1, angle, tilt);
  const wallP3 = project(p2[0], p2[1], z2, angle, tilt);
  const wallP4 = project(p1[0], p1[1], z2, angle, tilt);

  let doorPts = null;
  if (len > 1.0) {
    const interp = (u: number, v: number) => {
      const x = (1-u)*(1-v)*wallP1.x + u*(1-v)*wallP2.x + u*v*wallP3.x + (1-u)*v*wallP4.x;
      const y = (1-u)*(1-v)*wallP1.y + u*(1-v)*wallP2.y + u*v*wallP3.y + (1-u)*v*wallP4.y;
      return { x, y };
    };
    doorPts = [interp(0.4, 0), interp(0.6, 0), interp(0.6, 0.3), interp(0.4, 0.3)];
  }

  for (let i = 0; i < count; i++) {
    const u1 = (i + 0.25) / count;
    const u2 = (i + 0.75) / count;
    const interp = (u: number, v: number) => {
      const x = (1-u)*(1-v)*wallP1.x + u*(1-v)*wallP2.x + u*v*wallP3.x + (1-u)*v*wallP4.x;
      const y = (1-u)*(1-v)*wallP1.y + u*(1-v)*wallP2.y + u*v*wallP3.y + (1-u)*v*wallP4.y;
      return { x, y };
    };
    windows.push([interp(u1, 0.35), interp(u2, 0.35), interp(u2, 0.8), interp(u1, 0.8)]);
  }
  return { windows, door: doorPts };
}

export function buildFloorUnion(floorTiles: ReadonlySet<string>) {
  if (floorTiles.size === 0) return null;
  if (!PC?.union) return null;
  const tilePolys: PCPoly[] = [];
  floorTiles.forEach(t => {
    const [x, y] = t.split(",").map(Number);
    tilePolys.push([[[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1], [x, y]]]);
  });
  try {
    let acc: PCMulti = [tilePolys[0]];
    for (let i = 1; i < tilePolys.length; i++) acc = PC.union(acc, tilePolys[i]) as PCMulti;
    return acc;
  } catch { return null; }
}

export function getGridBounds(floorTiles: ReadonlySet<string>): GridBounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  floorTiles.forEach(t => {
    const [x, y] = t.split(",").map(Number);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  });
  if (minX === Infinity) return [-10, -10, 10, 10];
  return [minX - 5, minY - 5, maxX + 5, maxY + 5];
}

export function buildVoronoi(districts: readonly District[], gridBounds: GridBounds) {
  if (districts.length === 0) return null;
  const points = districts.map((d) => [d.x, d.y] as [number, number]);
  try { return Delaunay.from(points).voronoi(gridBounds); } catch { return null; }
}

export function buildBuildings(
  districts: readonly District[],
  voronoi: ReturnType<typeof buildVoronoi>,
  roadWidth: number,
  floorUnion: PCMulti | null
): Building[] {
  if (!voronoi) return [];
  const result: Building[] = [];
  for (let i = 0; i < districts.length; i++) {
    const cell = voronoi.cellPolygon(i);
    if (!cell || cell.length < 4) continue;
    const cellRing: PCRing = cell.map(([x, y]) => [x, y] as [number, number]);
    let clippedPieces: PCRing[] = [];

    if (floorUnion) {
      try {
        const clipped = PC.intersection([cellRing], floorUnion) as PCMulti;
        if (!clipped || clipped.length === 0) continue;
        for (const piece of clipped) {
          if (!piece || piece.length === 0) continue;
          const outer = piece[0];
          if (outer.length < 4) continue;
          clippedPieces.push(outer.slice(0, -1).map(([x, y]) => [x, y] as [number, number]));
        }
      } catch { clippedPieces = [cellRing.slice(0, -1)]; }
    } else { clippedPieces = [cellRing.slice(0, -1)]; }

    clippedPieces.forEach((rawPoly, pidx) => {
      if (rawPoly.length < 3 || polygonArea(rawPoly) < 0.3) return;
      const ccw = ensureCCW(rawPoly);
      const shrunk = shrinkPolygon(ccw, roadWidth / 2 + 0.15);
      if (polygonArea(shrunk) < 0.15) return;
      result.push({ district: districts[i], polygon: shrunk, pieceIdx: pidx });
    });
  }
  return result;
}

export function projectCity(
  buildings: readonly Building[],
  angle: number,
  tilt: number,
  palette: Palette,
  selectedId: string | null = null
): CityRenderObject[] {
  const objects: CityRenderObject[] = [];
  const isTopView = tilt <= 0.55;

  buildings.forEach(({ district, polygon, pieceIdx }) => {
    const visible = getVisibleEdges(polygon, angle, tilt);
    const bottomProj = polygon.map(([x, y]) => project(x, y, 0, angle, tilt));
    const topProj = polygon.map(([x, y]) => project(x, y, district.height, angle, tilt));

    // Безопасная точка внутри полигона (центроид может быть снаружи у вогнутых форм)
    const [apexX, apexY] = findInsidePoint(polygon);
    const apexProj = project(apexX, apexY, district.height + ROOF_HEIGHT, angle, tilt);

    const scx = topProj.reduce((s, p) => s + p.x, 0) / topProj.length;
    const isSelected = selectedId === district.id;
    const p = district.colorOverride || palette;
    const convex = isConvex(polygon);

    // Стены
    if (!isTopView) {
      visible.forEach(idx => {
        const j = (idx + 1) % polygon.length;
        const facePts = [bottomProj[idx], bottomProj[j], topProj[j], topProj[idx]];
        const color = (bottomProj[idx].x + bottomProj[j].x) / 2 > scx ? p.right : p.left;
        const { windows, door } = getWindowsOnWall(polygon[idx], polygon[j], 0, district.height, angle, tilt);

        const midX = (polygon[idx][0] + polygon[j][0]) / 2;
        const midY = (polygon[idx][1] + polygon[j][1]) / 2;
        const depth = getDepth(midX, midY, district.height / 2, angle);

        objects.push({
          type: 'wall',
          key: `${district.id}-${pieceIdx}-w-${idx}`,
          points: facePts.map(pt => `${pt.x},${pt.y}`).join(" "),
          color, outline: p.outline,
          windows: windows.map(winPts => winPts.map(pt => `${pt.x},${pt.y}`).join(" ")),
          door: door ? door.map(pt => `${pt.x},${pt.y}`).join(" ") : null,
          windowColor: p.window,
          depth, districtId: district.id
        });
      });
    }

    // Крыша — скатная только для выпуклых форм, в остальных случаях — плоская
    const usePitched = district.roofStyle === "pitched" && !isTopView && convex;

    if (!usePitched) {
      // Плоская крыша (вид сверху / вогнутый полигон / ручной выбор)
      const depth = getDepth(apexX, apexY, district.height, angle);
      objects.push({
        type: 'roof',
        key: `${district.id}-${pieceIdx}-roof`,
        points: topProj.map(pt => `${pt.x},${pt.y}`).join(" "),
        color: isSelected ? "#ffe082" : p.top,
        outline: p.outline,
        strokeWidth: isSelected ? 3 : 1.5,
        depth, districtId: district.id
      });
    } else {
      // Скатная крыша — ВСЕ грани пирамиды, каждая со своей глубиной
      for (let idx = 0; idx < polygon.length; idx++) {
        const j = (idx + 1) % polygon.length;
        const roofPts = [topProj[idx], topProj[j], apexProj];

        const d1 = getDepth(polygon[idx][0], polygon[idx][1], district.height, angle);
        const d2 = getDepth(polygon[j][0], polygon[j][1], district.height, angle);
        const d3 = getDepth(apexX, apexY, district.height + ROOF_HEIGHT, angle);
        const depth = (d1 + d2 + d3) / 3;

        objects.push({
          type: 'roof',
          key: `${district.id}-${pieceIdx}-r-${idx}`,
          points: roofPts.map(pt => `${pt.x},${pt.y}`).join(" "),
          color: isSelected ? "#ffe082" : p.top,
          outline: p.outline,
          strokeWidth: isSelected ? 3 : 1.5,
          depth, districtId: district.id
        });
      }
    }
  });

  return objects.sort((a, b) => a.depth - b.depth);
}
