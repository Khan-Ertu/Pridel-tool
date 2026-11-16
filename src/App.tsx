import { useState, useRef, useMemo, useEffect, useCallback } from "react";
import { Delaunay } from "d3-delaunay";
import * as PCModule from "polygon-clipping";
import { project, unproject, getDepth } from "./lib/iso";
import { downloadSvg } from "./lib/svgExport";
import type { Palette, District } from "./types";

const PC: any = (PCModule as any).default ?? PCModule;
type PCRing = [number, number][];
type PCPoly = PCRing[];
type PCMulti = PCPoly[];

const DEFAULT_PALETTE: Palette = {
  top: "#27ae60",
  left: "#f4d03f",
  right: "#d35400",
  window: "#2c3e50",
  outline: "#1a1a1a",
};

const ROOF_HEIGHT = 1.5;
const INITIAL_SIZE = 20;

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

const HexColorInput = ({ label, value, onChange }: { label: string, value: string, onChange: (val: string) => void }) => {
  const [text, setText] = useState(value);
  useEffect(() => { setText(value); }, [value]);

  const handleTextChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let v = e.target.value.trim();
    v = v.replace(/^#+/, "");
    if (v.length > 0) v = "#" + v;
    v = v.toUpperCase();
    setText(v);
    if (/^#[0-9A-F]{6}$/.test(v)) onChange(v);
  };

  return (
    <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4, fontSize: 12 }}>
      <span>{label}</span>
      <div style={{ display: "flex", gap: 4 }}>
        <input type="color" value={value} onChange={(e) => { onChange(e.target.value); setText(e.target.value); }} style={{ width: 24, height: 24, padding: 0, border: "none", cursor: "pointer" }} />
        <input type="text" value={text} onChange={handleTextChange} placeholder="#000000" style={{ width: 72, fontSize: 11, padding: "2px 4px", fontFamily: "monospace", border: "1px solid #ccc", borderRadius: 2, textTransform: "uppercase" }} />
      </div>
    </label>
  );
};

export default function App() {
  const [camera, setCamera] = useState({ x: 0, y: 150, zoom: 1 });
  const [angle, setAngle] = useState(0);
  const [tilt, setTilt] = useState(1);
  const [districts, setDistricts] = useState<District[]>([]);
  const [floorTiles, setFloorTiles] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    for (let x = -INITIAL_SIZE/2; x < INITIAL_SIZE/2; x++) {
      for (let y = -INITIAL_SIZE/2; y < INITIAL_SIZE/2; y++) {
        initial.add(`${x},${y}`);
      }
    }
    return initial;
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [palette, setPalette] = useState<Palette>(DEFAULT_PALETTE);
  const [roadWidth, setRoadWidth] = useState(1.0);
  const [heightVariation, setHeightVariation] = useState(0.5);
  const [globalHeight, setGlobalHeight] = useState(3);

  // НОВОЕ: состояния для фоновой картинки
  const [bgImage, setBgImage] = useState<string | null>(null);
  const [showBg, setShowBg] = useState(true);
  const [bgOpacity, setBgOpacity] = useState(0.5);
  const [bgWidth, setBgWidth] = useState(20);
  const [bgAspect, setBgAspect] = useState(1);
  const [bgX, setBgX] = useState(0);
  const [bgY, setBgY] = useState(0);

  const [tool, setTool] = useState<"district" | "brush" | "select" | "area" | "eraser">("district");
  const [areaMode, setAreaMode] = useState<"add" | "subtract">("add");

  const [history, setHistory] = useState<{districts: District[], tiles: Set<string>}[]>([]);

  const svgRef = useRef<SVGSVGElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imgInputRef = useRef<HTMLInputElement>(null);
  const bgInputRef = useRef<HTMLInputElement>(null); // НОВОЕ

  const [isPanning, setIsPanning] = useState(false);
  const [isRotating, setIsRotating] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const rotateStartRef = useRef({ x: 0, y: 0, angle: 0, tilt: 1 });
  
  const [draggingDistrictId, setDraggingDistrictId] = useState<string | null>(null);
  const [dragStart, setDragStart] = useState<{x: number, y: number} | null>(null);
  const [dragEnd, setDragEnd] = useState<{x: number, y: number} | null>(null);
  const [isPainting, setIsPainting] = useState(false);

  const pushHistory = useCallback(() => {
    setHistory(prev => [...prev.slice(-9), { 
      districts: JSON.parse(JSON.stringify(districts)),
      tiles: new Set(floorTiles)
    }]);
  }, [districts, floorTiles]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        if (history.length > 0) {
          const prev = history[history.length - 1];
          setDistricts(prev.districts); setFloorTiles(prev.tiles);
          setHistory(prevHistory => prevHistory.slice(0, -1));
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [history]);

  const floorUnion = useMemo(() => {
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
  }, [floorTiles]);

  const gridBounds = useMemo(() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    floorTiles.forEach(t => {
      const [x, y] = t.split(",").map(Number);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    });
    if (minX === Infinity) return [-10, -10, 10, 10];
    return [minX - 5, minY - 5, maxX + 5, maxY + 5];
  }, [floorTiles]);

  const voronoi = useMemo(() => {
    if (districts.length === 0) return null;
    const points = districts.map((d) => [d.x, d.y] as [number, number]);
    try { return Delaunay.from(points).voronoi(gridBounds as [number, number, number, number]); } catch { return null; }
  }, [districts, gridBounds]);

  const buildings = useMemo(() => {
    if (!voronoi) return [];
    const result: { district: District; polygon: [number, number][]; pieceIdx: number }[] = [];
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
  }, [districts, voronoi, roadWidth, floorUnion]);

  const renderObjects = useMemo(() => {
    const objects: any[] = [];
    const isTopView = tilt <= 0.55;

    buildings.forEach(({ district, polygon, pieceIdx }) => {
      const visible = getVisibleEdges(polygon, angle, tilt);
      const bottomProj = polygon.map(([x, y]) => project(x, y, 0, angle, tilt));
      const topProj = polygon.map(([x, y]) => project(x, y, district.height, angle, tilt));

      // Безопасная точка внутри полигона (центроид может быть снаружи у вогнутых форм)
      const [apexX, apexY] = findInsidePoint(polygon);
      const apexProj = project(apexX, apexY, district.height + ROOF_HEIGHT, angle, tilt);

      const scx = topProj.reduce((s, p) => s + p.x, 0) / topProj.length;
      const isSelected = selectedId === district.id && tool === "select";
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
  }, [buildings, angle, tilt, palette, selectedId, tool]);

  const handleExport = () => {
    if (!svgRef.current) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    floorTiles.forEach(t => {
      const [x, y] = t.split(",").map(Number);
      const p = project(x, y, 0, angle, tilt);
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      const p2 = project(x+1, y+1, 0, angle, tilt);
      if (p2.x < minX) minX = p2.x; if (p2.x > maxX) maxX = p2.x;
      if (p2.y < minY) minY = p2.y; if (p2.y > maxY) maxY = p2.y;
    });
    buildings.forEach(b => {
      b.polygon.forEach(([x, y]) => {
        const p = project(x, y, b.district.height + ROOF_HEIGHT, angle, tilt);
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      });
    });
    // Учитываем картинку фона
    if (showBg && bgImage) {
      const w = bgWidth;
      const h = bgWidth / bgAspect;
      const x0 = bgX - w / 2, y0 = bgY - h / 2;
      [[x0, y0], [x0 + w, y0], [x0, y0 + h], [x0 + w, y0 + h]].forEach(([x, y]) => {
        const p = project(x, y, 0, angle, tilt);
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      });
    }
    if (minX === Infinity) { minX = -100; minY = -100; maxX = 100; maxY = 100; }
    downloadSvg(svgRef.current, "pridel-city.svg", { minX, minY, maxX, maxY });
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const newZoom = e.deltaY < 0 ? camera.zoom * 1.1 : camera.zoom / 1.1;
    setCamera((prev) => ({ ...prev, zoom: Math.max(0.2, Math.min(newZoom, 4)) }));
  };

const getGridCoords = (e: React.PointerEvent | React.MouseEvent) => {
  const svg = svgRef.current;
  if (!svg) return { x: 0, y: 0 };

  // Нативная трансформация SVG автоматически учитывает:
  // - viewBox и его масштабирование
  // - preserveAspectRatio (центрирование + letterboxing)
  // - любые CSS-трансформации на <svg>
  const pt = svg.createSVGPoint();
  pt.x = e.clientX;
  pt.y = e.clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const svgPt = pt.matrixTransform(ctm.inverse());

  // svgPt теперь в координатах viewBox (-500…500), а не в пикселях экрана.
  // Далее отменяем transform самого <g> (translate + scale)
  const worldX = (svgPt.x - camera.x) / camera.zoom;
  const worldY = (svgPt.y - camera.y) / camera.zoom;

  // И переводим из изометрии в координаты сетки
  return unproject(worldX, worldY, angle, tilt);
};

  const addHouseAt = (x: number, y: number) => {
    if (districts.some((d) => Math.hypot(d.x - x, d.y - y) < 1.2)) return;
    setDistricts((prev) => [...prev, {
      id: `d-${Date.now()}-${Math.random().toString(36).slice(2,5)}`, x, y, height: globalHeight, roofStyle: "pitched"
    }]);
  };

  const handlePointerDown = (e: React.PointerEvent, id?: string) => {
    if (e.button === 1) {
      e.preventDefault();
      setIsPanning(true);
      setPanStart({ x: e.clientX - camera.x, y: e.clientY - camera.y });
      return;
    }
    if (e.button === 2) {
      rotateStartRef.current = { x: e.clientX, y: e.clientY, angle, tilt };
      setIsRotating(true);
      return;
    }
    if (e.button === 0) {
      const gridPt = getGridCoords(e);
      if (tool === "area") { setDragStart(gridPt); setDragEnd(gridPt); return; }
      if (tool === "district" && !id) { pushHistory(); addHouseAt(gridPt.x, gridPt.y); return; }
      if (tool === "brush" && !id) { pushHistory(); setIsPainting(true); addHouseAt(gridPt.x, gridPt.y); return; }
      if (tool === "eraser") { pushHistory(); setIsPainting(true); setDistricts(prev => prev.filter(d => Math.hypot(d.x - gridPt.x, d.y - gridPt.y) > 0.8)); return; }
      if (id && (tool === "district" || tool === "brush")) { setDraggingDistrictId(id); return; }
      const t = e.target as SVGElement;
      if (t.tagName === "svg" || t.id === "bg-rect") { setIsPanning(true); setPanStart({ x: e.clientX - camera.x, y: e.clientY - camera.y }); }
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (isRotating) {
      const r = rotateStartRef.current;
      const dx = e.clientX - r.x;
      const dy = e.clientY - r.y;
      setAngle(r.angle + dx * 0.5);
      setTilt(Math.max(0.5, Math.min(5.0, r.tilt + dy * 0.008)));
      return;
    }
    const gridPt = getGridCoords(e);
    if (dragStart && tool === "area") { setDragEnd(gridPt); return; }
    if (isPainting && tool === "eraser") { setDistricts(prev => prev.filter(d => Math.hypot(d.x - gridPt.x, d.y - gridPt.y) > 0.8)); return; }
    if (isPainting && tool === "brush") { addHouseAt(gridPt.x, gridPt.y); return; }
    if (draggingDistrictId) { setDistricts(prev => prev.map(d => d.id === draggingDistrictId ? { ...d, x: gridPt.x, y: gridPt.y } : d)); return; }
    if (isPanning) { setCamera((prev) => ({ ...prev, x: e.clientX - panStart.x, y: e.clientY - panStart.y })); }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (e.button === 1 || e.button === 0) {
      setIsPanning(false); setDraggingDistrictId(null); setDragStart(null); setDragEnd(null); setIsPainting(false);
    }
    if (e.button === 2) setIsRotating(false);

    if (dragStart && dragEnd && tool === "area") {
      const minX = Math.floor(Math.min(dragStart.x, dragEnd.x));
      const maxX = Math.floor(Math.max(dragStart.x, dragEnd.x));
      const minY = Math.floor(Math.min(dragStart.y, dragEnd.y));
      const maxY = Math.floor(Math.max(dragStart.y, dragEnd.y));
      pushHistory();
      const newTiles = new Set(floorTiles);
      for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
          if (areaMode === "add") newTiles.add(`${x},${y}`); else newTiles.delete(`${x},${y}`);
        }
      }
      setFloorTiles(newTiles);
    }
  };

  const handleDeleteDistrict = (e: React.MouseEvent, id: string) => {
    e.preventDefault(); e.stopPropagation();
    if (!districts.some(d => d.id === id)) return;
    pushHistory();
    setDistricts((prev) => prev.filter((d) => d.id !== id));
  };

  const generateRandomCity = () => {
    pushHistory();
    const tilesArray = Array.from(floorTiles);
    for (let i = tilesArray.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [tilesArray[i], tilesArray[j]] = [tilesArray[j], tilesArray[i]];
    }
    const newDistricts: District[] = [];
    const targetCount = Math.min(25, Math.floor(tilesArray.length / 3));
    const minDist = 1.2;
    for (const t of tilesArray) {
      if (newDistricts.length >= targetCount) break;
      const [tx, ty] = t.split(",").map(Number);
      const px = tx + 0.5, py = ty + 0.5;
      if (newDistricts.some(d => Math.hypot(d.x - px, d.y - py) < minDist)) continue;
      newDistricts.push({ id: `d-${Date.now()}-${Math.random().toString(36).slice(2,6)}`, x: px, y: py, height: 1 + Math.random() * (2 + heightVariation * 8), roofStyle: Math.random() > 0.3 ? "pitched" : "flat" });
    }
    setDistricts(newDistricts);
  };

  const applyGlobalHeight = () => { pushHistory(); setDistricts(prev => prev.map(d => ({ ...d, height: globalHeight }))); };
  const applyGlobalRoof = (style: "flat" | "pitched") => { pushHistory(); setDistricts(prev => prev.map(d => ({ ...d, roofStyle: style }))); };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return; pushHistory();
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const size = 24; const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d')!; ctx.drawImage(img, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size).data;
        const newDistricts: District[] = [];
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;
            if ((0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2]) < 128) {
              const px = x - size/2 + 0.5, py = y - size/2 + 0.5;
              if (!floorTiles.has(`${Math.floor(px)},${Math.floor(py)}`)) continue;
              newDistricts.push({ id: `img-${Date.now()}-${x}-${y}`, x: px, y: py, height: 2 + Math.random() * 4, roofStyle: "pitched" });
            }
          }
        }
        setDistricts(newDistricts);
      };
      img.src = ev.target?.result as string;
    };
    reader.readAsDataURL(file); e.target.value = "";
  };

  // НОВОЕ: загрузка фоновой картинки
  const handleBgUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string;
      const img = new Image();
      img.onload = () => {
        setBgImage(dataUrl);
        setBgAspect(img.width / img.height);
        setShowBg(true);
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const saveProject = () => {
    const data = { districts, palette, roadWidth, heightVariation, tiles: Array.from(floorTiles) };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = "pridel-city.json"; link.click(); URL.revokeObjectURL(url);
  };

  const loadProject = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const data = JSON.parse(event.target?.result as string); pushHistory();
        if (data.districts) setDistricts(data.districts);
        if (data.palette) setPalette(data.palette);
        if (data.roadWidth) setRoadWidth(data.roadWidth);
        if (data.heightVariation) setHeightVariation(data.heightVariation);
        if (data.tiles) setFloorTiles(new Set(data.tiles));
      } catch { alert("Ошибка формата"); }
    };
    reader.readAsText(file); e.target.value = "";
  };

  const selectedDistrict = districts.find((d) => d.id === selectedId);

  return (
    <div style={{ display: "flex", height: "100vh", background: "#f4f1ea", fontFamily: "sans-serif", overflow: "hidden" }}>
      <aside style={{ width: 340, padding: 20, borderRight: "1px solid #ddd", background: "#fff", overflowY: "auto", zIndex: 10 }}>
        <h2 style={{ margin: "0 0 16px 0" }}>Придел — v6.5</h2>

        <div style={{ marginBottom: 16, padding: 12, background: "#f0f7ff", borderRadius: 4 }}>
          <h4 style={{ margin: "0 0 8px 0", fontSize: 12 }}>Камера</h4>
          <label style={{ display: "block", marginBottom: 8, fontSize: 12 }}>
            <div>Наклон: {tilt.toFixed(2)}</div>
            <input type="range" min="0.5" max="5.0" step="0.1" value={tilt} onChange={(e) => setTilt(Number(e.target.value))} style={{ width: "100%" }} />
          </label>
          <button onClick={() => { setTilt(0.5); setAngle(45); }} style={{ width: "100%", padding: 6, background: "#2196f3", color: "#fff", border: "none", cursor: "pointer", fontSize: 12 }}>
            👁️ Вид строго сверху (90°)
          </button>
          <p style={{ margin: "4px 0 0 0", fontSize: 10, color: "#666" }}>Зажми ПКМ и веди мышью, чтобы вращать камеру.</p>
        </div>

        {/* НОВОЕ: Блок "Фон / Подложка" */}
        <div style={{ marginBottom: 16, padding: 12, background: "#f3e5f5", borderRadius: 4 }}>
          <h4 style={{ margin: "0 0 8px 0", fontSize: 12 }}>Фон / Подложка</h4>
          <input type="file" accept="image/*" ref={bgInputRef} onChange={handleBgUpload} style={{ display: "none" }} />
          
          <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
            <button onClick={() => bgInputRef.current?.click()} style={{ flex: 1, padding: 6, background: "#e1bee7", border: "1px solid #ce93d8", cursor: "pointer", fontSize: 11 }}>
              🖼️ {bgImage ? "Заменить" : "Загрузить"}
            </button>
            {bgImage && (
              <>
                <button onClick={() => setShowBg(!showBg)} style={{ flex: 1, padding: 6, background: showBg ? "#ce93d8" : "#eee", border: "1px solid #ccc", cursor: "pointer", fontSize: 11 }}>
                  {showBg ? "👁️ Скрыть" : "👁️ Показать"}
                </button>
                <button onClick={() => setBgImage(null)} style={{ padding: "6px 8px", background: "#ffcdd2", border: "1px solid #ef9a9a", cursor: "pointer", fontSize: 11, fontWeight: "bold" }} title="Удалить">
                  ×
                </button>
              </>
            )}
          </div>

          {bgImage && (
            <>
              <label style={{ display: "block", marginBottom: 6, fontSize: 11 }}>
                <div>Прозрачность: {(bgOpacity * 100).toFixed(0)}%</div>
                <input type="range" min="0.1" max="1" step="0.05" value={bgOpacity} onChange={(e) => setBgOpacity(Number(e.target.value))} style={{ width: "100%" }} />
              </label>
              <label style={{ display: "block", marginBottom: 6, fontSize: 11 }}>
                <div>Размер: {bgWidth.toFixed(1)}</div>
                <input type="range" min="5" max="60" step="1" value={bgWidth} onChange={(e) => setBgWidth(Number(e.target.value))} style={{ width: "100%" }} />
              </label>
              <label style={{ display: "block", marginBottom: 6, fontSize: 11 }}>
                <div>Сдвиг X: {bgX.toFixed(1)}</div>
                <input type="range" min="-30" max="30" step="0.5" value={bgX} onChange={(e) => setBgX(Number(e.target.value))} style={{ width: "100%" }} />
              </label>
              <label style={{ display: "block", marginBottom: 0, fontSize: 11 }}>
                <div>Сдвиг Y: {bgY.toFixed(1)}</div>
                <input type="range" min="-30" max="30" step="0.5" value={bgY} onChange={(e) => setBgY(Number(e.target.value))} style={{ width: "100%" }} />
              </label>
            </>
          )}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
          <button onClick={() => setTool("district")} style={{ padding: 8, background: tool === "district" ? "#90caf9" : "#eee", border: "1px solid #ccc", cursor: "pointer" }}>📍 Дома</button>
          <button onClick={() => setTool("brush")} style={{ padding: 8, background: tool === "brush" ? "#90caf9" : "#eee", border: "1px solid #ccc", cursor: "pointer" }}>🖌️ Кисть</button>
          <button onClick={() => setTool("select")} style={{ padding: 8, background: tool === "select" ? "#f4d03f" : "#eee", border: "1px solid #ccc", cursor: "pointer" }}>🏠 Выбор</button>
          <button onClick={() => setTool("eraser")} style={{ padding: 8, background: tool === "eraser" ? "#ef9a9a" : "#eee", border: "1px solid #ccc", cursor: "pointer" }}>🗑️ Ластик</button>
          <button onClick={() => setTool("area")} style={{ gridColumn: "span 2", padding: 8, background: tool === "area" ? "#ffcc80" : "#eee", border: "1px solid #ccc", cursor: "pointer" }}>⬜ Поле</button>
        </div>

        {tool === "area" && (
          <div style={{ marginBottom: 16, padding: 12, background: "#fff3e0", borderRadius: 4 }}>
             <h4 style={{ margin: "0 0 8px 0", fontSize: 12 }}>Размер поля</h4>
             <div style={{ display: "flex", gap: 8 }}>
               <button onClick={() => setAreaMode("add")} style={{ flex: 1, padding: 6, background: areaMode === "add" ? "#ffb74d" : "#fff", border: "1px solid #ccc" }}>➕ Добавить</button>
               <button onClick={() => setAreaMode("subtract")} style={{ flex: 1, padding: 6, background: areaMode === "subtract" ? "#ffb74d" : "#fff", border: "1px solid #ccc" }}>➖ Вычесть</button>
             </div>
          </div>
        )}

        {selectedDistrict && tool === "select" && (
          <div style={{ marginBottom: 16, padding: 12, background: "#fff9c4", borderRadius: 4 }}>
            <h4 style={{ margin: "0 0 8px 0", fontSize: 12 }}>Выбранное здание</h4>
            <label style={{ display: "block", fontSize: 12, marginBottom: 8 }}>
              <div>Высота: {selectedDistrict.height.toFixed(1)}</div>
              <input type="range" min="0.5" max="15" step="0.1" value={selectedDistrict.height} onChange={(e) => setDistricts((prev) => prev.map((d) => d.id === selectedDistrict.id ? { ...d, height: Number(e.target.value) } : d))} style={{ width: "100%" }} />
            </label>
            <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
               <button onClick={() => setDistricts(prev => prev.map(d => d.id === selectedDistrict.id ? {...d, roofStyle: "flat"} : d))} style={{ flex: 1, padding: 6, background: selectedDistrict.roofStyle === "flat" ? "#f4d03f" : "#eee", border: "1px solid #ccc", fontSize: 11 }}>Плоская</button>
               <button onClick={() => setDistricts(prev => prev.map(d => d.id === selectedDistrict.id ? {...d, roofStyle: "pitched"} : d))} style={{ flex: 1, padding: 6, background: selectedDistrict.roofStyle === "pitched" ? "#f4d03f" : "#eee", border: "1px solid #ccc", fontSize: 11 }}>Скатная</button>
            </div>
            
            <div style={{ fontSize: 11, fontWeight: "bold", marginBottom: 4 }}>Цвета дома:</div>
            <HexColorInput label="Крыша" value={selectedDistrict.colorOverride?.top || palette.top} onChange={(v) => setDistricts(prev => prev.map(d => d.id === selectedDistrict.id ? {...d, colorOverride: { ...(d.colorOverride || palette), top: v }} : d))} />
            <HexColorInput label="Свет" value={selectedDistrict.colorOverride?.left || palette.left} onChange={(v) => setDistricts(prev => prev.map(d => d.id === selectedDistrict.id ? {...d, colorOverride: { ...(d.colorOverride || palette), left: v }} : d))} />
            <HexColorInput label="Тень" value={selectedDistrict.colorOverride?.right || palette.right} onChange={(v) => setDistricts(prev => prev.map(d => d.id === selectedDistrict.id ? {...d, colorOverride: { ...(d.colorOverride || palette), right: v }} : d))} />
            <HexColorInput label="Окна" value={selectedDistrict.colorOverride?.window || palette.window} onChange={(v) => setDistricts(prev => prev.map(d => d.id === selectedDistrict.id ? {...d, colorOverride: { ...(d.colorOverride || palette), window: v }} : d))} />

            <button onClick={() => {
              setDistricts(prev => prev.map(d => d.id === selectedDistrict.id ? {...d, colorOverride: undefined} : d));
            }} style={{ width: "100%", padding: 4, marginTop: 8, background: "#eee", border: "1px solid #ccc", fontSize: 10, cursor: "pointer" }}>Сбросить цвета</button>
          </div>
        )}

        <div style={{ marginBottom: 16, padding: 12, background: "#fce4ec", borderRadius: 4 }}>
          <h4 style={{ margin: "0 0 8px 0", fontSize: 12 }}>Глобально</h4>
          <label style={{ display: "block", marginBottom: 8, fontSize: 12 }}>
            <div>Высота всех: {globalHeight.toFixed(1)}</div>
            <div style={{ display: "flex", gap: 4 }}>
              <input type="range" min="0.5" max="15" step="0.1" value={globalHeight} onChange={(e) => setGlobalHeight(Number(e.target.value))} style={{ flex: 1 }} />
              <button onClick={applyGlobalHeight} style={{ padding: "2px 8px", background: "#e91e63", color: "#fff", border: "none", cursor: "pointer", fontSize: 11 }}>ОК</button>
            </div>
          </label>
          <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
            <button onClick={() => applyGlobalRoof("flat")} style={{ flex: 1, padding: 6, background: "#eee", border: "1px solid #ccc", fontSize: 11 }}>Все плоские</button>
            <button onClick={() => applyGlobalRoof("pitched")} style={{ flex: 1, padding: 6, background: "#eee", border: "1px solid #ccc", fontSize: 11 }}>Все скатные</button>
          </div>
        </div>

        <div style={{ marginBottom: 16, padding: 12, background: "#f0f7ff", borderRadius: 4 }}>
          <h4 style={{ margin: "0 0 8px 0", fontSize: 12 }}>Генерация</h4>
          <label style={{ display: "block", marginBottom: 8, fontSize: 12 }}>
            <div>Разброс высот: {heightVariation.toFixed(2)}</div>
            <input type="range" min="0.1" max="1" step="0.05" value={heightVariation} onChange={(e) => setHeightVariation(Number(e.target.value))} style={{ width: "100%" }} />
          </label>
          <button onClick={generateRandomCity} style={{ width: "100%", padding: 8, background: "#27ae60", color: "#fff", border: "none", cursor: "pointer", fontWeight: "bold" }}>
            🎲 Случайный город
          </button>
        </div>

        <div style={{ marginBottom: 16 }}>
          <h4 style={{ margin: "0 0 8px 0", fontSize: 12, color: "#888" }}>Параметры</h4>
          <label style={{ display: "block", marginBottom: 8, fontSize: 12 }}>
            <div>Ширина улиц: {roadWidth.toFixed(1)}</div>
            <input type="range" min="0.2" max="3" step="0.1" value={roadWidth} onChange={(e) => setRoadWidth(Number(e.target.value))} style={{ width: "100%" }} />
          </label>
        </div>

        <div style={{ marginBottom: 16 }}>
          <h4 style={{ margin: "0 0 8px 0", fontSize: 12, color: "#888" }}>Базовая палитра</h4>
          <HexColorInput label="Крыша" value={palette.top} onChange={(v) => setPalette({...palette, top: v})} />
          <HexColorInput label="Свет" value={palette.left} onChange={(v) => setPalette({...palette, left: v})} />
          <HexColorInput label="Тень" value={palette.right} onChange={(v) => setPalette({...palette, right: v})} />
          <HexColorInput label="Окна" value={palette.window} onChange={(v) => setPalette({...palette, window: v})} />
        </div>

        <div style={{ display: "grid", gap: 6 }}>
          <button onClick={() => imgInputRef.current?.click()} style={{ padding: 8, background: "#e1bee7", border: "1px solid #ce93d8", cursor: "pointer" }}>🖼️ Импорт из фото (силуэт)</button>
          <input type="file" accept="image/*" ref={imgInputRef} onChange={handleImageUpload} style={{ display: "none" }} />
          <button onClick={saveProject} style={{ padding: 8, background: "#e8f5e9", border: "1px solid #a5d6a7", cursor: "pointer" }}>💾 Сохранить (JSON)</button>
          <button onClick={() => fileInputRef.current?.click()} style={{ padding: 8, background: "#fff3e0", border: "1px solid #ffcc80", cursor: "pointer" }}>📂 Загрузить (JSON)</button>
          <input type="file" accept=".json" ref={fileInputRef} onChange={loadProject} style={{ display: "none" }} />
          <button onClick={() => { pushHistory(); setDistricts([]); }} style={{ padding: 8, background: "#ffebee", border: "1px solid #ef9a9a", cursor: "pointer" }}>🗑️ Очистить дома</button>
          <button onClick={handleExport} style={{ padding: 8, background: "#e3f2fd", border: "1px solid #90caf9", cursor: "pointer" }}>⬇️ Скачать SVG (обрезка)</button>
        </div>
      </aside>

      <main 
        style={{ flex: 1, position: "relative", cursor: isPanning ? "grabbing" : isRotating ? "move" : (tool === "area" || tool === "district" || tool === "brush" || tool === "eraser") ? "crosshair" : "default" }} 
        onWheel={handleWheel}
      >
        <svg
          ref={svgRef}
          viewBox="-500 -500 1000 1000"
          style={{ width: "100%", height: "100%", userSelect: "none" }}
          onPointerDown={(e) => handlePointerDown(e)}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
          onContextMenu={(e) => e.preventDefault()}
        >
          <defs>
            <clipPath id="floor-clip">
              {Array.from(floorTiles).map(t => {
                const [x, y] = t.split(",").map(Number);
                const pts = [project(x, y, 0, angle, tilt), project(x+1, y, 0, angle, tilt), project(x+1, y+1, 0, angle, tilt), project(x, y+1, 0, angle, tilt)];
                return <polygon key={`clip-${t}`} points={pts.map(p => `${p.x},${p.y}`).join(" ")} />;
              })}
            </clipPath>
          </defs>

          <rect id="bg-rect" x="-1000" y="-1000" width="2000" height="2000" fill="#f8f8f8" />

          <g transform={`translate(${camera.x}, ${camera.y}) scale(${camera.zoom})`}>
            
            <g className="ui-no-export">
              {Array.from(floorTiles).map(tileStr => {
                const [x, y] = tileStr.split(",").map(Number);
                const pts = [project(x, y, 0, angle, tilt), project(x+1, y, 0, angle, tilt), project(x+1, y+1, 0, angle, tilt), project(x, y+1, 0, angle, tilt)];
                return (
                  <polygon key={`tile-${tileStr}`} points={pts.map(p => `${p.x},${p.y}`).join(" ")} fill="#e0e0e0" stroke="#ccc" strokeWidth={1} />
                );
              })}
            </g>

            {dragStart && dragEnd && tool === "area" && (
              <polygon
                points={[
                  {x: Math.floor(Math.min(dragStart.x, dragEnd.x)), y: Math.floor(Math.min(dragStart.y, dragEnd.y))},
                  {x: Math.floor(Math.max(dragStart.x, dragEnd.x)) + 1, y: Math.floor(Math.min(dragStart.y, dragEnd.y))},
                  {x: Math.floor(Math.max(dragStart.x, dragEnd.x)) + 1, y: Math.floor(Math.max(dragStart.y, dragEnd.y)) + 1},
                  {x: Math.floor(Math.min(dragStart.x, dragEnd.x)), y: Math.floor(Math.max(dragStart.y, dragEnd.y)) + 1}
                ].map(p => {
                  const proj = project(p.x, p.y, 0, angle, tilt); return `${proj.x},${proj.y}`;
                }).join(" ")}
                fill={areaMode === "add" ? "#81c784" : "#e57373"} fillOpacity={0.4} stroke={areaMode === "add" ? "#2e7d32" : "#c62828"} strokeWidth={2}
                style={{ pointerEvents: "none" }}
              />
            )}

{voronoi && (
  <g className="ui-no-export" clipPath="url(#floor-clip)" style={{ pointerEvents: "none" }}>
                {districts.map((_, i) => {
                  const cell = voronoi.cellPolygon(i);
                  if (!cell) return null;
                  const str = cell.map((p: any) => { const pt = project(p[0], p[1], 0, angle, tilt); return `${pt.x},${pt.y}`; }).join(" ");
                  return (
                    <g key={`road-${i}`}>
                      <polygon points={str} fill="#dcedc8" fillOpacity={0.3} />
                      <polygon points={str} fill="none" stroke="#95a5a6" strokeWidth={roadWidth * 24} strokeLinejoin="round" strokeLinecap="round" />
                    </g>
                  );
                })}
              </g>
            )}

            {/* НОВОЕ: картинка фона на полу */}
            {showBg && bgImage && (() => {
              const w = bgWidth;
              const h = bgWidth / bgAspect;
              const x0 = bgX - w / 2;
              const y0 = bgY - h / 2;
              const p0 = project(x0, y0, 0, angle, tilt);
              const p1 = project(x0 + w, y0, 0, angle, tilt);
              const p3 = project(x0, y0 + h, 0, angle, tilt);
              const a = (p1.x - p0.x) / w;
              const b = (p1.y - p0.y) / w;
              const c = (p3.x - p0.x) / h;
              const d = (p3.y - p0.y) / h;
              return (
<image
  className="ui-no-export"
  href={bgImage}
  x="0" y="0" width={w} height={h}
  transform={`matrix(${a} ${b} ${c} ${d} ${p0.x} ${p0.y})`}
  opacity={bgOpacity}
  style={{ pointerEvents: "none" }}
/>
              );
            })()}

            {renderObjects.map(obj => {
              if (obj.type === 'wall') {
                return (
                  <g key={obj.key}>
                    <polygon
                      points={obj.points}
                      fill={obj.color}
                      stroke={obj.outline}
                      strokeWidth={1.5}
                      strokeLinejoin="round"
                      style={{ pointerEvents: tool === "district" || tool === "brush" ? "none" : "auto", cursor: tool === "eraser" ? "crosshair" : "default" }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (tool === "eraser") handleDeleteDistrict(e, obj.districtId);
                        if (tool === "select") setSelectedId(obj.districtId);
                      }}
                    />
                    {obj.windows.map((winStr: string, wi: number) => (
                      <polygon key={wi} points={winStr} fill={obj.windowColor} stroke={obj.outline} strokeWidth={1} style={{ pointerEvents: "none" }} />
                    ))}
                    {obj.door && (
                      <polygon points={obj.door} fill={obj.outline} style={{ pointerEvents: "none" }} />
                    )}
                  </g>
                );
              }
              return (
                <polygon
                  key={obj.key}
                  points={obj.points}
                  fill={obj.color}
                  stroke={obj.outline}
                  strokeWidth={obj.strokeWidth}
                  strokeLinejoin="round"
                  style={{ cursor: "pointer", pointerEvents: tool === "district" || tool === "brush" ? "none" : "auto" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (tool === "eraser") handleDeleteDistrict(e, obj.districtId);
                    if (tool === "select") setSelectedId(obj.districtId);
                  }}
                />
              );
            })}

            <g className="ui-no-export">
              {districts.map((d) => {
                const proj = project(d.x, d.y, 0, angle, tilt);
                return (
                  <g
                    key={`marker-${d.id}`}
                    onPointerDown={(e) => {
                      if (tool === "district" || tool === "brush") {
                        e.stopPropagation();
                        handlePointerDown(e, d.id);
                      }
                    }}
                    onContextMenu={(e) => handleDeleteDistrict(e, d.id)}
                    style={{ cursor: "grab", pointerEvents: "auto" }}
                  >
                    <circle cx={proj.x} cy={proj.y} r={10} fill="transparent" />
                    <circle cx={proj.x} cy={proj.y} r={5} fill="#fff" stroke="#e74c3c" strokeWidth={2} />
                  </g>
                );
              })}
            </g>
          </g>
        </svg>
      </main>
    </div>
  );
}