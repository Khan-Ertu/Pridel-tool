import type { MouseEvent } from "react";
import type { CityRenderObject } from "../lib/cityScene";

interface CityArtworkProps {
  renderObjects: readonly CityRenderObject[];
  tool?: "district" | "brush" | "select" | "area" | "eraser";
  onDistrictClick?: (event: MouseEvent<SVGPolygonElement>, districtId: string) => void;
}

export function CityArtwork({ renderObjects, tool, onDistrictClick }: CityArtworkProps) {
  const pointerEvents = !onDistrictClick || tool === "district" || tool === "brush" ? "none" : "auto";
  const clickFace = (event: MouseEvent<SVGPolygonElement>, districtId: string) => {
    if (!onDistrictClick) return;
    event.stopPropagation();
    onDistrictClick(event, districtId);
  };

  return (
    <>
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
                style={{ pointerEvents, cursor: tool === "eraser" ? "crosshair" : "default" }}
                onClick={event => clickFace(event, obj.districtId)}
              />
              {obj.windows.map((winStr, wi) => (
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
            style={{ cursor: "pointer", pointerEvents }}
            onClick={event => clickFace(event, obj.districtId)}
          />
        );
      })}
    </>
  );
}
