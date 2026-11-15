export function downloadSvg(svgElement: SVGSVGElement | null, filename = "pridel-house.svg") {
  if (!svgElement) return;
  const clone = svgElement.cloneNode(true) as SVGSVGElement;
  
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  
  // Удаляем всё, что помечено как UI (сетка пола, рамки и т.д.)
  clone.querySelectorAll(".ui-no-export").forEach(el => el.remove());
  
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