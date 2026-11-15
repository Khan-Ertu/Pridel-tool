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

function getVisibleEdges(poly: [number, number][], angle: number): number[] {
  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad); const sin = Math.sin(rad);
  const rotated = poly.map(([x, y]) => [x * cos - y * sin, x * sin + y * cos]);
  const visible: number[] = [];
  for (let i = 0; i < rotated.length; i++) {
    const a = rotated[i]; const b = rotated[(i + 1) % rotated.length];
    if ((b[1] - a[1]) - (b[0] - a[0]) > 0) visible.push(i);
  }
  return visible;
}

function getWindowsOnWall(
  p1: [number, number], p2: [number, number], z1: number, z2: number, angle: number, tilt: number
) {
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  const len = Math.hypot(dx, dy);
  const count = Math.max(1, Math.floor(len / 1.5));
  const windows = [];
  const wallP1 = project(p1[0], p1[1], z1, angle, tilt);
  const wallP2 = project(p2[0], p2[1], z1, angle, tilt);
  const wallP3 = project(p2[0], p2[1], z2, angle, tilt);
  const wallP4 = project(p1[0], p1[1], z2, angle, tilt);
  for (let i = 0; i < count; i++) {
    const u1 = (i + 0.25) / count;
    const u2 = (i + 0.75) / count;
    const interp = (u: number, v: number) => {
      const x = (1-u)*(1-v)*wallP1.x + u*(1-v)*wallP2.x + u*v*wallP3.x + (1-u)*v*wallP4.x;
      const y = (1-u)*(1-v)*wallP1.y + u*(1-v)*wallP2.y + u*v*wallP3.y + (1-u)*v*wallP4.y;
      return { x, y };
    };
    windows.push([interp(u1, 0.25), interp(u2, 0.25), interp(u2, 0.75), interp(u1, 0.75)]);
  }
  return windows;
}

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
  
  // НОВОЕ: Глобальная высота для всех домов
  const [globalHeight, setGlobalHeight] = useState(3);

  const [tool, setTool] = useState<"district" | "select" | "area" | "eraser">("district");
  const [areaMode, setAreaMode] = useState<"add" | "subtract">("add");

  const [history, setHistory] = useState<{districts: District[], tiles: Set<string>}[]>([]);

  const svgRef = useRef<SVGSVGElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imgInputRef = useRef<HTMLInputElement>(null);

  const [isPanning, setIsPanning] = useState(false);
  const [isRotating, setIsRotating] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
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
          setDistricts(prev.districts);
          setFloorTiles(prev.tiles);
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

  const sortedBuildings = useMemo(() => {
    return [...buildings].sort((a, b) => {
      const ca = a.polygon.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]);
      const cb = b.polygon.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]);
      return getDepth(ca[0]/a.polygon.length, ca[1]/a.polygon.length, 0, angle) - 
             getDepth(cb[0]/b.polygon.length, cb[1]/b.polygon.length, 0, angle);
    });
  }, [buildings, angle]);

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const newZoom = e.deltaY < 0 ? camera.zoom * 1.1 : camera.zoom / 1.1;
    setCamera((prev) => ({ ...prev, zoom: Math.max(0.2, Math.min(newZoom, 4)) }));
  };

  const getGridCoords = (e: React.PointerEvent | React.MouseEvent) => {
    if (!svgRef.current) return { x: 0, y: 0 };
    const rect = svgRef.current.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * 1000 - 500;
    const svgY = ((e.clientY - rect.top) / rect.height) * 1000 - 500;
    return unproject((svgX - camera.x) / camera.zoom, (svgY - camera.y) / camera.zoom, angle, tilt);
  };

  const handleFloorClick = (e: React.MouseEvent, x: number, y: number) => {
    e.stopPropagation();
    if (tool === "area") return;
    pushHistory();
    if (tool === "district") {
      const px = x + 0.5, py = y + 0.5;
      if (districts.some((d) => Math.hypot(d.x - px, d.y - py) < 0.4)) return;
      setDistricts((prev) => [...prev, {
        id: `d-${Date.now()}-${Math.random().toString(36).slice(2,5)}`, x: px, y: py, height: globalHeight, roofStyle: "pitched"
      }]);
    }
  };

  const handlePointerDown = (e: React.PointerEvent, id?: string) => {
    if (e.button === 2) {
      setIsRotating(true);
      setPanStart({ x: e.clientX, y: angle });
      return;
    }
    if (e.button === 0) {
      const gridPt = getGridCoords(e);
      if (tool === "area") {
        setDragStart(gridPt); setDragEnd(gridPt);
        return;
      }
      if (id && tool === "district") {
        setDraggingDistrictId(id);
        return;
      }
      if (tool === "district" && !id) {
        setIsPainting(true);
        return;
      }
      const t = e.target as SVGElement;
      if (t.tagName === "svg" || t.id === "bg-rect") {
        setIsPanning(true);
        setPanStart({ x: e.clientX - camera.x, y: e.clientY - camera.y });
      }
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (isRotating) {
      setAngle(panStart.y + (e.clientX - panStart.x) * 0.5);
      return;
    }
    const gridPt = getGridCoords(e);
    if (dragStart && tool === "area") {
      setDragEnd(gridPt);
      return;
    }
    if (draggingDistrictId) {
      setDistricts(prev => prev.map(d => d.id === draggingDistrictId ? { ...d, x: gridPt.x, y: gridPt.y } : d));
      return;
    }
    if (isPainting && tool === "district") {
      const px = gridPt.x, py = gridPt.y;
      if (!districts.some((d) => Math.hypot(d.x - px, d.y - py) < 1.2)) {
        setDistricts((prev) => [...prev, {
          id: `d-${Date.now()}-${Math.random().toString(36).slice(2,5)}`, x: px, y: py, height: globalHeight, roofStyle: "pitched"
        }]);
      }
      return;
    }
    if (isPanning) {
      setCamera((prev) => ({ ...prev, x: e.clientX - panStart.x, y: e.clientY - panStart.y }));
    }
  };

  const handlePointerUp = () => {
    if (dragStart && dragEnd && tool === "area") {
      const minX = Math.floor(Math.min(dragStart.x, dragEnd.x));
      const maxX = Math.floor(Math.max(dragStart.x, dragEnd.x));
      const minY = Math.floor(Math.min(dragStart.y, dragEnd.y));
      const maxY = Math.floor(Math.max(dragStart.y, dragEnd.y));
      pushHistory();
      const newTiles = new Set(floorTiles);
      for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
          if (areaMode === "add") newTiles.add(`${x},${y}`);
          else newTiles.delete(`${x},${y}`);
        }
      }
      setFloorTiles(newTiles);
    }
    setIsPanning(false); setIsRotating(false);
    setDraggingDistrictId(null); setDragStart(null); setDragEnd(null);
    setIsPainting(false);
  };

  const handleDeleteDistrict = (e: React.MouseEvent, id: string) => {
    e.preventDefault(); e.stopPropagation();
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
      const tooClose = newDistricts.some(d => Math.hypot(d.x - px, d.y - py) < minDist);
      if (tooClose) continue;
      newDistricts.push({
        id: `d-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
        x: px, y: py,
        height: 1 + Math.random() * (2 + heightVariation * 8),
        roofStyle: Math.random() > 0.3 ? "pitched" : "flat"
      });
    }
    setDistricts(newDistricts);
  };

  // НОВОЕ: Функции глобальных настроек
  const applyGlobalHeight = () => {
    pushHistory();
    setDistricts(prev => prev.map(d => ({ ...d, height: globalHeight })));
  };

  const applyGlobalRoof = (style: "flat" | "pitched") => {
    pushHistory();
    setDistricts(prev => prev.map(d => ({ ...d, roofStyle: style })));
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    pushHistory();
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const size = 24; 
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size).data;
        const newDistricts: District[] = [];
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;
            const lum = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
            if (lum < 128) {
              const px = x - size/2 + 0.5;
              const py = y - size/2 + 0.5;
              const tileKey = `${Math.floor(px)},${Math.floor(py)}`;
              if (!floorTiles.has(tileKey)) continue;
              newDistricts.push({
                id: `img-${Date.now()}-${x}-${y}`,
                x: px, y: py, height: 2 + Math.random() * 4, roofStyle: "pitched"
              });
            }
          }
        }
        setDistricts(newDistricts);
      };
      img.src = ev.target?.result as string;
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const saveProject = () => {
    const data = { districts, palette, roadWidth, heightVariation, tiles: Array.from(floorTiles) };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = "pridel-city.json"; link.click();
    URL.revokeObjectURL(url);
  };

  const loadProject = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const data = JSON.parse(event.target?.result as string);
        pushHistory();
        if (data.districts) setDistricts(data.districts);
        if (data.palette) setPalette(data.palette);
        if (data.roadWidth) setRoadWidth(data.roadWidth);
        if (data.heightVariation) setHeightVariation(data.heightVariation);
        if (data.tiles) setFloorTiles(new Set(data.tiles));
      } catch { alert("Ошибка формата"); }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const selectedDistrict = districts.find((d) => d.id === selectedId);

  return (
    <div style={{ display: "flex", height: "100vh", background: "#f4f1ea", fontFamily: "sans-serif", overflow: "hidden" }}>
      <aside style={{ width: 340, padding: 20, borderRight: "1px solid #ddd", background: "#fff", overflowY: "auto", zIndex: 10 }}>
        <h2 style={{ margin: "0 0 16px 0" }}>Придел — v5.1</h2>

        <div style={{ marginBottom: 16, padding: 12, background: "#f0f7ff", borderRadius: 4 }}>
          <h4 style={{ margin: "0 0 8px 0", fontSize: 12 }}>Камера</h4>
          <label style={{ display: "block", marginBottom: 8, fontSize: 12 }}>
            <div>Наклон: {tilt.toFixed(2)}</div>
            <input type="range" min="0.1" max="2" step="0.05" value={tilt} onChange={(e) => setTilt(Number(e.target.value))} style={{ width: "100%" }} />
          </label>
          <button onClick={() => { setTilt(0.1); setAngle(0); }} style={{ width: "100%", padding: 6, background: "#2196f3", color: "#fff", border: "none", cursor: "pointer", fontSize: 12 }}>👁️ Вид сверху</button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
          <button onClick={() => setTool("district")} style={{ padding: 8, background: tool === "district" ? "#90caf9" : "#eee", border: "1px solid #ccc", cursor: "pointer" }}>📍 Дома</button>
          <button onClick={() => setTool("select")} style={{ padding: 8, background: tool === "select" ? "#f4d03f" : "#eee", border: "1px solid #ccc", cursor: "pointer" }}>🏠 Выбор</button>
          <button onClick={() => setTool("area")} style={{ padding: 8, background: tool === "area" ? "#ffcc80" : "#eee", border: "1px solid #ccc", cursor: "pointer" }}>⬜ Поле</button>
          <button onClick={() => setTool("eraser")} style={{ padding: 8, background: tool === "eraser" ? "#ef9a9a" : "#eee", border: "1px solid #ccc", cursor: "pointer" }}>🗑️ Ластик</button>
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

        {/* НОВОЕ: Глобальные настройки */}
        <div style={{ marginBottom: 16, padding: 12, background: "#fce4ec", borderRadius: 4 }}>
          <h4 style={{ margin: "0 0 8px 0", fontSize: 12 }}>Глобальные настройки домов</h4>
          
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

        {selectedDistrict && tool === "select" && (
          <div style={{ marginBottom: 16, padding: 12, background: "#fff9c4", borderRadius: 4 }}>
            <h4 style={{ margin: "0 0 8px 0", fontSize: 12 }}>Выбранное здание</h4>
            <label style={{ display: "block", fontSize: 12, marginBottom: 8 }}>
              <div>Высота: {selectedDistrict.height.toFixed(1)}</div>
              <input type="range" min="0.5" max="15" step="0.1" value={selectedDistrict.height} onChange={(e) => setDistricts((prev) => prev.map((d) => d.id === selectedDistrict.id ? { ...d, height: Number(e.target.value) } : d))} style={{ width: "100%" }} />
            </label>
            <div style={{ display: "flex", gap: 4 }}>
               <button onClick={() => setDistricts(prev => prev.map(d => d.id === selectedDistrict.id ? {...d, roofStyle: "flat"} : d))} style={{ flex: 1, padding: 6, background: selectedDistrict.roofStyle === "flat" ? "#f4d03f" : "#eee", border: "1px solid #ccc", fontSize: 11 }}>Плоская</button>
               <button onClick={() => setDistricts(prev => prev.map(d => d.id === selectedDistrict.id ? {...d, roofStyle: "pitched"} : d))} style={{ flex: 1, padding: 6, background: selectedDistrict.roofStyle === "pitched" ? "#f4d03f" : "#eee", border: "1px solid #ccc", fontSize: 11 }}>Скатная</button>
            </div>
          </div>
        )}

        <div style={{ marginBottom: 16 }}>
          <h4 style={{ margin: "0 0 8px 0", fontSize: 12, color: "#888" }}>Палитра</h4>
          {(["top", "left", "right", "window"] as const).map((key) => (
            <label key={key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4, fontSize: 12 }}>
              <span>{key === "top" ? "Крыша" : key === "left" ? "Свет" : key === "right" ? "Тень" : "Окна"}</span>
              <input type="color" value={palette[key]} onChange={(e) => setPalette({ ...palette, [key]: e.target.value })} style={{ width: 30, height: 20, padding: 0, border: "none", cursor: "pointer" }} />
            </label>
          ))}
        </div>

        <div style={{ display: "grid", gap: 6 }}>
          <button onClick={() => imgInputRef.current?.click()} style={{ padding: 8, background: "#e1bee7", border: "1px solid #ce93d8", cursor: "pointer" }}>🖼️ Импорт из фото</button>
          <input type="file" accept="image/*" ref={imgInputRef} onChange={handleImageUpload} style={{ display: "none" }} />
          <button onClick={saveProject} style={{ padding: 8, background: "#e8f5e9", border: "1px solid #a5d6a7", cursor: "pointer" }}>💾 Сохранить (JSON)</button>
          <button onClick={() => fileInputRef.current?.click()} style={{ padding: 8, background: "#fff3e0", border: "1px solid #ffcc80", cursor: "pointer" }}>📂 Загрузить (JSON)</button>
          <input type="file" accept=".json" ref={fileInputRef} onChange={loadProject} style={{ display: "none" }} />
          <button onClick={() => { pushHistory(); setDistricts([]); }} style={{ padding: 8, background: "#ffebee", border: "1px solid #ef9a9a", cursor: "pointer" }}>🗑️ Очистить дома</button>
          <button onClick={() => downloadSvg(svgRef.current, "pridel-city.svg")} style={{ padding: 8, background: "#e3f2fd", border: "1px solid #90caf9", cursor: "pointer" }}>⬇️ Скачать SVG</button>
        </div>
      </aside>

      <main style={{ flex: 1, position: "relative", cursor: isPanning || draggingDistrictId ? "grabbing" : isRotating ? "ew-resize" : tool === "area" ? "crosshair" : "default" }} onWheel={handleWheel}>
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
                  <polygon
                    key={`tile-${tileStr}`}
                    points={pts.map(p => `${p.x},${p.y}`).join(" ")}
                    fill="#e0e0e0" stroke="#ccc" strokeWidth={1}
                    onClick={(e) => handleFloorClick(e, x, y)}
                  />
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
              <g clipPath="url(#floor-clip)" style={{ pointerEvents: "none" }}>
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

            {sortedBuildings.map(({ district, polygon, pieceIdx }) => {
              const visible = getVisibleEdges(polygon, angle);
              const bottomProj = polygon.map(([x, y]) => project(x, y, 0, angle, tilt));
              const topProj = polygon.map(([x, y]) => project(x, y, district.height, angle, tilt));
              
              const cx = polygon.reduce((s, p) => s + p[0], 0) / polygon.length;
              const cy = polygon.reduce((s, p) => s + p[1], 0) / polygon.length;
              const apexProj = project(cx, cy, district.height + ROOF_HEIGHT, angle, tilt);
              const scx = topProj.reduce((s, p) => s + p.x, 0) / topProj.length;
              const isSelected = selectedId === district.id && tool === "select";

              return (
                <g key={`${district.id}-${pieceIdx}`}>
                  {visible.map((idx) => {
                    const j = (idx + 1) % polygon.length;
                    const facePts = [bottomProj[idx], bottomProj[j], topProj[j], topProj[idx]];
                    const color = (bottomProj[idx].x + bottomProj[j].x) / 2 > scx ? palette.right : palette.left;
                    const winPtsList = getWindowsOnWall(polygon[idx], polygon[j], 0, district.height, angle, tilt);

                    return (
                      <g key={`side-${idx}`}>
                        <polygon 
                          points={facePts.map((p) => `${p.x},${p.y}`).join(" ")} 
                          fill={color} stroke={palette.outline} strokeWidth={1.5} strokeLinejoin="round" 
                          style={{ pointerEvents: tool === "district" ? "none" : "auto", cursor: tool === "eraser" ? "crosshair" : "default" }}
                          onClick={(e) => { 
                            e.stopPropagation(); 
                            if (tool === "eraser") handleDeleteDistrict(e, district.id);
                            if (tool === "select") setSelectedId(district.id);
                          }}
                        />
                        {winPtsList.map((winPts, wi) => (
                          <polygon key={`win-${wi}`} points={winPts.map((p) => `${p.x},${p.y}`).join(" ")} fill={palette.window} stroke={palette.outline} strokeWidth={1} style={{ pointerEvents: "none" }} />
                        ))}
                      </g>
                    );
                  })}

                  {district.roofStyle === "flat" ? (
                    <polygon
                      points={topProj.map((p) => `${p.x},${p.y}`).join(" ")}
                      fill={isSelected ? "#ffe082" : palette.top}
                      stroke={palette.outline} strokeWidth={isSelected ? 3 : 1.5} strokeLinejoin="round"
                      style={{ cursor: "pointer", pointerEvents: tool === "district" ? "none" : "auto" }}
                      onClick={(e) => { 
                        e.stopPropagation(); 
                        if (tool === "eraser") handleDeleteDistrict(e, district.id);
                        if (tool === "select") setSelectedId(district.id);
                      }}
                    />
                  ) : (
                    visible.map((idx) => {
                      const j = (idx + 1) % polygon.length;
                      return (
                        <polygon
                          key={`roof-${idx}`}
                          points={[topProj[idx], topProj[j], apexProj].map((p) => `${p.x},${p.y}`).join(" ")}
                          fill={isSelected ? "#ffe082" : palette.top}
                          stroke={palette.outline} strokeWidth={isSelected ? 3 : 1.5} strokeLinejoin="round"
                          style={{ cursor: "pointer", pointerEvents: tool === "district" ? "none" : "auto" }}
                          onClick={(e) => { 
                            e.stopPropagation(); 
                            if (tool === "eraser") handleDeleteDistrict(e, district.id);
                            if (tool === "select") setSelectedId(district.id);
                          }}
                        />
                      );
                    })
                  )}
                </g>
              );
            })}

            <g className="ui-no-export">
              {districts.map((d) => {
                const proj = project(d.x, d.y, 0, angle, tilt);
                return (
                  <g key={`marker-${d.id}`} onPointerDown={(e) => handlePointerDown(e, d.id)} onContextMenu={(e) => handleDeleteDistrict(e, d.id)} style={{ cursor: "grab", pointerEvents: "auto" }}>
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