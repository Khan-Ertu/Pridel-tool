export function downloadSvg(
  svgElement: SVGSVGElement | null,
  filename = "pridel-city.svg",
  bounds?: { minX: number; minY: number; maxX: number; maxY: number }
) {
  if (!svgElement) return;
  const clone = svgElement.cloneNode(true) as SVGSVGElement;

  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");

  // Обрезка по bounds (плотная композиция без пустых полей)
  if (bounds && bounds.maxX > bounds.minX) {
    const padding = 40;
    const w = (bounds.maxX - bounds.minX) + padding * 2;
    const h = (bounds.maxY - bounds.minY) + padding * 2;
    clone.setAttribute("viewBox", `${bounds.minX - padding} ${bounds.minY - padding} ${w} ${h}`);
    clone.style.background = "transparent";
  }

  // Удаляем всё служебное: сетку пола, дороги, фон, маркеры
  clone.querySelectorAll(".ui-no-export").forEach(el => el.remove());

  // Удаляем сам фон-прямоугольник (он вне ui-no-export)
  const bgRect = clone.querySelector("#bg-rect");
  if (bgRect) bgRect.remove();

  const serializer = new XMLSerializer();
  const svgString = serializer.serializeToString(clone);
  const blob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}