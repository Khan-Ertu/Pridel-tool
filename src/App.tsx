import { useState, useRef, useMemo } from "react";
import { Delaunay } from "d3-delaunay";
import { project, getDepth } from "./lib/iso";
import { downloadSvg } from "./lib/svgExport";
import type { Palette } from "./types";

const DEFAULT_PALETTE: Palette = {
  top: "#27ae60",
  left: "#f4d03f",
  right: "#d35400",
  window: "#2c3e50",
  outline: "#1a1a1a",
};

interface District {
  id: string;
  x: number;
  y: number;
  height: number;
}

const GRID_SIZE = 24;
const ROAD_WIDTH = 1.0;    // Ширина дороги (в клетках)
const SHRINK = 0.65;       // Отступ дома от дороги (создает эффект тротуара)

// --- Утилиты полигонов ---

function shrinkPolygon(poly: [number, number][], amount: number): [number, number][] {
  if (poly.length < 3) return poly;
  const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
  const cy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
  return poly.map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) return [cx, cy] as [number, number];
    const t = Math.max(0.05, (len - amount) / len);
    return [cx + dx * t, cy + dy * t] as [number, number];
  });
}

function polygonArea(poly: [number, number][]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

function ensureCCW(poly: [number, number][]): [number, number][] {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    s += x1 * y2 - x2 * y1;
  }
  return s > 0 ? poly : [...poly].reverse();
}

function getVisibleEdges(poly: [number, number][], angle: number): number[] {
  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rotated = poly.map(([x, y]) => [x * cos - y * sin, x * sin + y * cos]);
  const visible: number[] = [];
  for (let i = 0; i < rotated.length; i++) {
    const a = rotated[i];
    const b = rotated[(i + 1) % rotated.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    if (dy - dx > 0) visible.push(i);
  }
  return visible;
}

// Отрисовка окна на грани
function getWindowPoints(p1: any, p2: any, p3: any, p4: any) {
  const interp = (u: number, v: number) => {
    const x = (1-u)*(1-v)*p1.x + u*(1-v)*p2.x + u*v*p3.x + (1-u)*v*p4.x;
    const y = (1-u)*(1-v)*p1.y + u*(1-v)*p2.y + u*v*p3.y + (1-u)*v*p4.y;
    return { x, y };
  };
  return [interp(0.3, 0.2), interp(0.7, 0.2), interp(0.7, 0.8), interp(0.3, 0.8)];
}

export default function App() {
  const [camera, setCamera] = useState({ x: 0, y: 150, zoom: 1 });
  const [angle, setAngle] = useState(0);
  const [districts, setDistricts] = useState<District[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [palette, setPalette] = useState<Palette>(DEFAULT_PALETTE);
  const [heightVariation, setHeightVariation] = useState(0.5);
  
  // Режимы работы
  const [tool, setTool] = useState<"district" | "select">("district");

  const svgRef = useRef<SVGSVGElement>(null);
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });

  // --- Вороной ---
  const voronoi = useMemo(() => {
    if (districts.length === 0) return null;
    const points = districts.map((d) => [d.x, d.y] as [number, number]);
    const bounds: [number, number, number, number] = [
      -GRID_SIZE / 2, -GRID_SIZE / 2, GRID_SIZE / 2, GRID_SIZE / 2,
    ];
    try {
      return Delaunay.from(points).voronoi(bounds);
    } catch {
      return null;
    }
  }, [districts]);

  // --- Здания ---
  const buildings = useMemo(() => {
    if (!voronoi) return [];
    const result: { district: District; polygon: [number, number][] }[] = [];
    for (let i = 0; i < districts.length; i++) {
      const cell = voronoi.cellPolygon(i);
      if (!cell) continue;
      const poly = ensureCCW(cell.slice(0, -1) as [number, number][]);
      const shrunk = shrinkPolygon(poly, SHRINK);
      if (polygonArea(shrunk) < 0.3) continue;
      result.push({ district: districts[i], polygon: shrunk });
    }
    return result;
  }, [districts, voronoi]);

  const sortedBuildings = useMemo(() => {
    return [...buildings].sort((a, b) => {
      const ca = a.polygon.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]);
      const cb = b.polygon.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]);
      const cx = ca[0] / a.polygon.length, cy = ca[1] / a.polygon.length;
      const dx = cb[0] / b.polygon.length, dy = cb[1] / b.polygon.length;
      return getDepth(cx, cy, 0, angle) - getDepth(dx, dy, 0, angle);
    });
  }, [buildings, angle]);

  // --- Камера ---
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const newZoom = e.deltaY < 0 ? camera.zoom * 1.1 : camera.zoom / 1.1;
    setCamera((prev) => ({ ...prev, zoom: Math.max(0.2, Math.min(newZoom, 4)) }));
  };

  // --- Клик по полу ---
  const handleFloorClick = (e: React.MouseEvent, x: number, y: number) => {
    e.stopPropagation();
    if (tool !== "district") return; // Ставим точки только в режиме районов
    
    const px = x + 0.5, py = y + 0.5;
    if (districts.some((d) => Math.hypot(d.x - px, d.y - py) < 0.4)) return;
    setDistricts((prev) => [
      ...prev,
      { id: `d-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, x: px, y: py, height: 2 + Math.random() * 4 },
    ]);
  };

  // --- Удаление района ---
  const handleDistrictRightClick = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDistricts((prev) => prev.filter((d) => d.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  // --- Случайный город ---
  const generateRandomCity = () => {
    const newDistricts: District[] = [];
    const numPoints = 12 + Math.floor(Math.random() * 8);
    
    for (let i = 0; i < numPoints; i++) {
      // Распределяем точки более-менее равномерно
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.random() * (GRID_SIZE / 2 - 2);
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      
      newDistricts.push({
        id: `d-${Date.now()}-${i}`,
        x, y,
        height: 1 + Math.random() * (2 + heightVariation * 8)
      });
    }
    setDistricts(newDistricts);
    setSelectedId(null);
  };

  const selectedDistrict = districts.find((d) => d.id === selectedId);

  return (
    <div style={{ display: "flex", height: "100vh", background: "#f4f1ea", fontFamily: "sans-serif", overflow: "hidden" }}>
      <aside style={{ width: 320, padding: 20, borderRight: "1px solid #ddd", background: "#fff", overflowY: "auto", zIndex: 10 }}>
        <h2 style={{ margin: "0 0 20px 0" }}>Придел — Город</h2>

        {/* РЕЖИМЫ */}
        <div style={{ marginBottom: 20, display: "flex", gap: 8 }}>
          <button 
            onClick={() => setTool("district")} 
            style={{ flex: 1, padding: 10, background: tool === "district" ? "#90caf9" : "#eee", border: "1px solid #ccc", cursor: "pointer", fontWeight: tool === "district" ? "bold" : "normal" }}
          >
            📍 Точки
          </button>
          <button 
            onClick={() => setTool("select")} 
            style={{ flex: 1, padding: 10, background: tool === "select" ? "#f4d03f" : "#eee", border: "1px solid #ccc", cursor: "pointer", fontWeight: tool === "select" ? "bold" : "normal" }}
          >
            🏠 Выбор
          </button>
        </div>

        <div style={{ marginBottom: 16, padding: 12, background: "#f0f7ff", borderRadius: 4, fontSize: 12 }}>
          {tool === "district" ? (
            <b>Режим: Расстановка точек. Кликай по полу, чтобы создать район.</b>
          ) : (
            <b>Режим: Выбор зданий. Кликай по крышам, чтобы настроить высоту.</b>
          )}
          <div style={{ marginTop: 8, color: "#666" }}>ПКМ по красной точке — удалить.</div>
        </div>

        {/* ГЕНЕРАЦИЯ */}
        <div style={{ marginBottom: 20 }}>
          <h4 style={{ margin: "0 0 12px 0", fontSize: 12, textTransform: "uppercase", color: "#888" }}>Генерация</h4>
          <label style={{ display: "block", marginBottom: 8, fontSize: 12 }}>
            <div>Разброс высот: {heightVariation.toFixed(2)}</div>
            <input type="range" min="0.1" max="1" step="0.05" value={heightVariation} onChange={(e) => setHeightVariation(Number(e.target.value))} style={{ width: "100%" }} />
          </label>
          <button onClick={generateRandomCity} style={{ width: "100%", padding: 10, background: "#27ae60", color: "#fff", border: "none", cursor: "pointer", fontWeight: "bold", marginBottom: 8 }}>🎲 Случайный город</button>
        </div>

        {/* ВЫБРАННОЕ ЗДАНИЕ */}
        {selectedDistrict && tool === "select" && (
          <div style={{ marginBottom: 16, padding: 12, background: "#fff9c4", borderRadius: 4 }}>
            <h4 style={{ margin: "0 0 8px 0", fontSize: 12 }}>Выбранное здание</h4>
            <label style={{ display: "block", fontSize: 12 }}>
              <div>Высота: {selectedDistrict.height.toFixed(1)}</div>
              <input
                type="range" min="0.5" max="15" step="0.1" value={selectedDistrict.height}
                onChange={(e) => setDistricts((prev) => prev.map((d) => d.id === selectedDistrict.id ? { ...d, height: Number(e.target.value) } : d))}
                style={{ width: "100%" }}
              />
            </label>
            <button onClick={() => { setDistricts((prev) => prev.filter((d) => d.id !== selectedDistrict.id)); setSelectedId(null); }} style={{ width: "100%", padding: 6, marginTop: 8, background: "#ffebee", border: "1px solid #ef9a9a", cursor: "pointer", fontSize: 12 }}>
              Удалить здание
            </button>
          </div>
        )}

        {/* КАМЕРА И ПАЛИТРА */}
        <div style={{ marginBottom: 16 }}>
          <h4 style={{ margin: "0 0 12px 0", fontSize: 12, textTransform: "uppercase", color: "#888" }}>Камера</h4>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setAngle((a) => a - 90)} style={{ flex: 1, padding: 8 }}>↺ 90°</button>
            <button onClick={() => setAngle((a) => a + 90)} style={{ flex: 1, padding: 8 }}>↻ 90°</button>
          </div>
        </div>

        <div style={{ marginBottom: 20 }}>
          <h4 style={{ margin: "0 0 12px 0", fontSize: 12, textTransform: "uppercase", color: "#888" }}>Палитра</h4>
          {(["top", "left", "right", "outline"] as const).map((key) => (
            <label key={key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, fontSize: 13 }}>
              <span>{key === "top" ? "Крыша" : key === "left" ? "Светлая стена" : key === "right" ? "Теневая стена" : "Контур"}</span>
              <input type="color" value={palette[key]} onChange={(e) => setPalette({ ...palette, [key]: e.target.value })} style={{ width: 40, height: 24, padding: 0, border: "none", cursor: "pointer" }} />
            </label>
          ))}
        </div>

        <button onClick={() => { setDistricts([]); setSelectedId(null); }} style={{ width: "100%", padding: 10, background: "#ffebee", border: "1px solid #ef9a9a", cursor: "pointer", marginBottom: 8 }}>Очистить всё</button>
        <button onClick={() => downloadSvg(svgRef.current, "pridel-city.svg")} style={{ width: "100%", padding: 10, background: "#e3f2fd", border: "1px solid #90caf9", cursor: "pointer" }}>⬇️ Скачать SVG</button>
      </aside>

      <main style={{ flex: 1, position: "relative", cursor: isPanning ? "grabbing" : tool === "district" ? "crosshair" : "default" }} onWheel={handleWheel}>
        <svg
          ref={svgRef}
          viewBox="-500 -500 1000 1000"
          style={{ width: "100%", height: "100%", userSelect: "none" }}
          onPointerDown={(e) => {
            const t = e.target as SVGElement;
            if (t.tagName === "svg" || t.id === "bg-rect") {
              setIsPanning(true);
              setPanStart({ x: e.clientX - camera.x, y: e.clientY - camera.y });
            }
          }}
          onPointerMove={(e) => {
            if (isPanning) setCamera((prev) => ({ ...prev, x: e.clientX - panStart.x, y: e.clientY - panStart.y }));
          }}
          onPointerUp={() => setIsPanning(false)}
          onPointerLeave={() => setIsPanning(false)}
        >
          <rect id="bg-rect" x="-1000" y="-1000" width="2000" height="2000" fill="#f8f8f8" />

          <g transform={`translate(${camera.x}, ${camera.y}) scale(${camera.zoom})`}>
            {/* ПОЛ */}
            <g className="ui-no-export">
              {Array.from({ length: GRID_SIZE }).map((_, x) =>
                Array.from({ length: GRID_SIZE }).map((_, y) => {
                  const ox = x - GRID_SIZE / 2;
                  const oy = y - GRID_SIZE / 2;
                  const p1 = project(ox, oy, 0, angle);
                  const p2 = project(ox + 1, oy, 0, angle);
                  const p3 = project(ox + 1, oy + 1, 0, angle);
                  const p4 = project(ox, oy + 1, 0, angle);
                  return (
                    <polygon
                      key={`f-${x}-${y}`}
                      points={[p1, p2, p3, p4].map((p) => `${p.x},${p.y}`).join(" ")}
                      fill="#e0e0e0"
                      stroke="#ccc"
                      strokeWidth={1}
                      onClick={(e) => handleFloorClick(e, ox, oy)}
                    />
                  );
                })
              )}
            </g>

            {/* ДОРОГИ (широкие) */}
            {voronoi && (
              <g className="ui-no-export" style={{ pointerEvents: "none" }}>
                {districts.map((_, i) => {
                  const cell = voronoi.cellPolygon(i);
                  if (!cell) return null;
                  const pts = cell.map((p: any) => project(p[0], p[1], 0, angle));
                  const str = pts.map((p) => `${p.x},${p.y}`).join(" ");
                  return (
                    <g key={`road-${i}`}>
                      <polygon points={str} fill="#dcedc8" fillOpacity={0.3} />
                      {/* Толстая линия дороги */}
                      <polygon points={str} fill="none" stroke="#95a5a6" strokeWidth={ROAD_WIDTH * 24} strokeLinejoin="round" strokeLinecap="round" />
                    </g>
                  );
                })}
              </g>
            )}

            {/* ЗДАНИЯ */}
            {sortedBuildings.map(({ district, polygon }) => {
              const visible = getVisibleEdges(polygon, angle);
              const bottomProj = polygon.map(([x, y]) => project(x, y, 0, angle));
              const topProj = polygon.map(([x, y]) => project(x, y, district.height, angle));

              const scx = topProj.reduce((s, p) => s + p.x, 0) / topProj.length;
              const isSelected = selectedId === district.id && tool === "select";

              return (
                <g key={district.id}>
                  {visible.map((idx) => {
                    const j = (idx + 1) % polygon.length;
                    const facePts = [bottomProj[idx], bottomProj[j], topProj[j], topProj[idx]];
                    const midX = (bottomProj[idx].x + bottomProj[j].x) / 2;
                    const color = midX > scx ? palette.right : palette.left;

                    // Окна на грани
                    const winPts = getWindowPoints(bottomProj[idx], bottomProj[j], topProj[j], topProj[idx]);
                    const winStr = winPts.map((p) => `${p.x},${p.y}`).join(" ");

                    return (
                      <g key={`side-${idx}`}>
                        <polygon
                          points={facePts.map((p) => `${p.x},${p.y}`).join(" ")}
                          fill={color}
                          stroke={palette.outline}
                          strokeWidth={1.5}
                          strokeLinejoin="round"
                          style={{ pointerEvents: tool === "district" ? "none" : "auto" }}
                        />
                        <polygon points={winStr} fill={palette.window} stroke={palette.outline} strokeWidth={1} style={{ pointerEvents: "none" }} />
                      </g>
                    );
                  })}
                  <polygon
                    points={topProj.map((p) => `${p.x},${p.y}`).join(" ")}
                    fill={isSelected ? "#ffe082" : palette.top}
                    stroke={palette.outline}
                    strokeWidth={isSelected ? 3 : 1.5}
                    strokeLinejoin="round"
                    style={{ cursor: tool === "select" ? "pointer" : "default", pointerEvents: tool === "district" ? "none" : "auto" }}
                    onClick={(e) => { e.stopPropagation(); if (tool === "select") setSelectedId(district.id); }}
                  />
                </g>
              );
            })}

            {/* МАРКЕРЫ ТОЧЕК */}
            <g className="ui-no-export">
              {districts.map((d) => {
                const proj = project(d.x, d.y, 0, angle);
                return (
                  <g key={`marker-${d.id}`} onContextMenu={(e) => handleDistrictRightClick(e, d.id)} style={{ cursor: "pointer", pointerEvents: "auto" }}>
                    <circle cx={proj.x} cy={proj.y} r={9} fill="#fff" opacity={0.7} />
                    <circle cx={proj.x} cy={proj.y} r={5} fill="#e74c3c" />
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