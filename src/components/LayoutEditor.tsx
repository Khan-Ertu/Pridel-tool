import { useMemo, useRef, useState } from "react";
import type { PointerEvent } from "react";
import { CityArtwork } from "./CityArtwork";
import type { CityRenderObject } from "../lib/cityScene";
import { downloadSvg } from "../lib/svgExport";
import "./LayoutEditor.css";

const formats = {
  "Пост · 4:5": [1080, 1350],
  "Квадрат · 1:1": [1080, 1080],
  "Сторис · 9:16": [1080, 1920],
  "Экран · 16:9": [1920, 1080],
} as const;

type Format = keyof typeof formats;
type Layer = "city" | "title" | "date" | "body";
type Point = { x: number; y: number };
const initialPositions: Record<Layer, Point> = {
  city: { x: .5, y: .56 },
  title: { x: .08, y: .15 },
  date: { x: .08, y: .27 },
  body: { x: .08, y: .86 },
};

const fields = [
  { id: "title", label: "Заголовок", size: .095, weight: 800 },
  { id: "date", label: "Дата", size: .068, weight: 700 },
  { id: "body", label: "Основной текст", size: .035, weight: 500 },
] as const;

export function LayoutEditor({ artwork, onEditCity }: {
  artwork: readonly CityRenderObject[];
  onEditCity: () => void;
}) {
  const [stage, setStage] = useState(0);
  const [format, setFormat] = useState<Format>("Пост · 4:5");
  const [background, setBackground] = useState("#f4f1ea");
  const [ink, setInk] = useState("#1a1a1a");
  const [content, setContent] = useState({ title: "", date: "", body: "" });
  const [positions, setPositions] = useState(initialPositions);
  const [scale, setScale] = useState(.85);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: Layer; pointerId: number; offset: Point } | null>(null);
  const [width, height] = formats[format];
  const bounds = useMemo(() => {
    if (!artwork.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const face of artwork) {
      for (const pair of face.points.split(" ")) {
        const [x, y] = pair.split(",").map(Number);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    return { minX, minY, maxX, maxY };
  }, [artwork]);
  const cityScale = bounds ? scale * Math.min(
    width / Math.max(1, bounds.maxX - bounds.minX),
    height / Math.max(1, bounds.maxY - bounds.minY),
  ) : 1;

  function pointerPosition(event: PointerEvent<SVGElement>) {
    const matrix = svgRef.current?.getScreenCTM();
    if (!matrix) return null;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return { x: point.x / width, y: point.y / height };
  }

  function startDrag(event: PointerEvent<SVGGElement>, id: Layer) {
    if (stage !== 2 || event.button !== 0) return;
    const point = pointerPosition(event);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      id,
      pointerId: event.pointerId,
      offset: { x: positions[id].x - point.x, y: positions[id].y - point.y },
    };
  }

  function moveLayer(event: PointerEvent<SVGSVGElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const point = pointerPosition(event);
    if (!point) return;
    setPositions(previous => ({
      ...previous,
      [active.id]: {
        x: Math.max(0, Math.min(1, point.x + active.offset.x)),
        y: Math.max(0, Math.min(1, point.y + active.offset.y)),
      },
    }));
  }

  function endDrag(event: PointerEvent<SVGSVGElement>) {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  }

  return (
    <main className="layout-editor">
      <aside className="layout-controls">
        <button type="button" onClick={onEditCity}>← Редактор города</button>
        <h1>Макет фестиваля</h1>
        <nav aria-label="Шаги редактирования">
          {["Формат", "Текст", "Композиция"].map((label, index) => (
            <button key={label} type="button" aria-current={stage === index ? "step" : undefined}
              onClick={() => setStage(index)}>{label}</button>
          ))}
        </nav>
        {stage === 0 && <>
          <label>Формат холста
            <select value={format} onChange={event => setFormat(event.target.value as Format)}>
              {Object.keys(formats).map(name => <option key={name}>{name}</option>)}
            </select>
          </label>
          <label>Цвет фона <input type="color" value={background} onChange={event => setBackground(event.target.value)} /></label>
        </>}
        {stage === 1 && <>
          {fields.map(({ id, label }) => (
            <label key={id}>{label}
              <textarea rows={id === "body" ? 4 : 2} value={content[id]}
                onChange={event => setContent({ ...content, [id]: event.target.value })} />
            </label>
          ))}
          <label>Цвет текста <input type="color" value={ink} onChange={event => setInk(event.target.value)} /></label>
        </>}
        {stage === 2 && <>
          <p>Перетащите город или текст на холсте.</p>
          <label>Масштаб города
            <input type="range" min=".1" max="2" step=".01" value={scale} disabled={!bounds}
              onChange={event => setScale(Number(event.target.value))} />
          </label>
          <button type="button" onClick={() => setPositions(initialPositions)}>Сбросить позиции</button>
          <button type="button" onClick={() => downloadSvg(svgRef.current, "pridel-layout.svg")}>Скачать SVG</button>
        </>}
        {stage < 2 && <button type="button" onClick={() => setStage(stage + 1)}>Далее →</button>}
        {!bounds && <p>Добавьте здания в редакторе города, чтобы они появились на холсте.</p>}
      </aside>
      <section className="layout-preview" aria-label="Предпросмотр макета">
        <svg ref={svgRef} width={width} height={height} viewBox={`0 0 ${width} ${height}`}
          role="img" aria-label="Макет фестиваля" data-compose={stage === 2}
          onPointerMove={moveLayer} onPointerUp={endDrag} onPointerCancel={endDrag}
          onLostPointerCapture={endDrag} style={{ overflow: "hidden" }}>
          <rect width={width} height={height} fill={background} />
          {bounds && (
            <g transform={`translate(${positions.city.x * width} ${positions.city.y * height}) scale(${cityScale}) translate(${-(bounds.minX + bounds.maxX) / 2} ${-(bounds.minY + bounds.maxY) / 2})`}
              onPointerDown={event => startDrag(event, "city")} pointerEvents="bounding-box">
              <CityArtwork renderObjects={artwork} />
            </g>
          )}
          {fields.map(({ id, size, weight }) => content[id] && (
            <g key={id} transform={`translate(${positions[id].x * width} ${positions[id].y * height})`}
              onPointerDown={event => startDrag(event, id)} pointerEvents="bounding-box">
              <text fill={ink} fontFamily="Arial, sans-serif" fontSize={width * size}
                fontWeight={weight} xmlSpace="preserve">
                {content[id].split("\n").map((line, index) => (
                  <tspan key={index} x="0" y={index * width * size * 1.06}>{line}</tspan>
                ))}
              </text>
            </g>
          ))}
        </svg>
      </section>
    </main>
  );
}
