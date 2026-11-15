import { Delaunay } from "d3-delaunay";
import * as PCModule from "polygon-clipping";
import type { Cell, Pt, Polygon, House } from "../types";
import type { Rng } from "./rng";

const PC: any = (PCModule as any).default ?? PCModule;
const hasClipping = PC && typeof PC.intersection === "function";

type PCRing = [number, number][];
type PCPoly = PCRing[];
type PCMulti = PCPoly[];

function bounds(poly: Polygon): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of poly) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

function ensureClosed(poly: Polygon): Polygon {
  if (poly.length < 2) return poly;
  const a = poly[0], b = poly[poly.length - 1];
  if (a[0] === b[0] && a[1] === b[1]) return poly;
  return [...poly, [a[0], a[1]] as Pt];
}

function stripClosingPoint(poly: Polygon): Polygon {
  if (poly.length < 2) return poly;
  const a = poly[0], b = poly[poly.length - 1];
  if (a[0] === b[0] && a[1] === b[1]) return poly.slice(0, -1);
  return poly;
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

function depthForPoint(type: string, weight: number): number {
  switch (type) {
    case "tower": return 80 * weight;
    case "roof": return 40 * weight;
    case "annex": return 30 * weight;
    case "balcony": return 25 * weight;
    case "void": return 0;
    case "windowCluster": return 50 * weight;
    default: return 45 * weight; // База
  }
}

export function computeCells(houses: House[], rng: Rng): Cell[] {
  const cells: Cell[] = [];

  for (const house of houses) {
    if (house.points.length < 3 || house.silhouette.length < 3) continue;

    const [minX, minY, maxX, maxY] = bounds(house.silhouette);
    const pad = Math.max(80, (maxX - minX + maxY - minY) * 0.25);

    const delaunay = Delaunay.from(house.points.map(p => [p.x, p.y] as [number, number]));
    const voronoi = delaunay.voronoi([minX - pad, minY - pad, maxX + pad, maxY + pad]);

    const silhouetteClosed = ensureClosed(house.silhouette);
    const silhouettePC: PCPoly = [silhouetteClosed.map(([x, y]) => [x, y] as [number, number])];

    for (let i = 0; i < house.points.length; i++) {
      const raw = voronoi.cellPolygon(i);
      if (!raw) continue;

      const ring: PCRing = raw.map(([x, y]) => [x, y]);
      const rawPoly: Polygon = stripClosingPoint(ring.map(([x, y]) => [x, y] as Pt));
      let finalPoly: Polygon | null = null;

      if (hasClipping) {
        try {
          const cellPC: PCPoly = [ring];
          const clipped = PC.intersection(cellPC, silhouettePC) as PCMulti;
          if (clipped && clipped.length > 0) {
            let best: Polygon | null = null, bestArea = 0;
            for (const poly of clipped) {
              if (!poly || poly.length === 0) continue;
              const converted: Polygon = poly[0].map(([x, y]) => [x, y] as Pt);
              const area = Math.abs(signedArea(converted));
              if (area > bestArea) { bestArea = area; best = converted; }
            }
            if (best && bestArea > 4) finalPoly = stripClosingPoint(best);
          }
        } catch (err) {}
      }

      if (!finalPoly) {
        if (Math.abs(signedArea(rawPoly)) < 4) continue;
        finalPoly = rawPoly;
      }

      const pt = house.points[i];
      cells.push({
        id: `cell-${house.id}-${i}`,
        houseId: house.id,
        polygon: finalPoly,
        depth: depthForPoint(pt.type, pt.weight),
        z: 0,
        type: pt.type,
        seed: rng.int(0, 1e9),
      });
    }
  }

  return cells;
}