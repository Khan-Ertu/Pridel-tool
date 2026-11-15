import type { SitePoint, PointType } from "../types";

interface Props {
  point: SitePoint;
  onChange: (updated: SitePoint) => void;
  onDelete: (id: string) => void;
}

const TYPES: { value: PointType; label: string }[] = [
  { value: "base", label: "База (обычный блок)" },
  { value: "tower", label: "Башня (сильный выступ)" },
  { value: "annex", label: "Пристройка (мелкий блок)" },
  { value: "balcony", label: "Балконная зона" },
  { value: "roof", label: "Крыша (навес)" },
  { value: "void", label: "Пустота (двор)" },
  { value: "windowCluster", label: "Оконный кластер" },
];

export function Inspector({ point, onChange, onDelete }: Props) {
  return (
    <div style={{ 
      padding: 16, 
      background: "#fff", 
      border: "1px solid #c8c4ba", 
      borderRadius: 8,
      marginTop: 16
    }}>
      <h4 style={{ margin: "0 0 12px 0" }}>Точка: {point.id}</h4>
      
      <label style={{ display: "block", marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>Тип</div>
        <select
          value={point.type}
          onChange={(e) => onChange({ ...point, type: e.target.value as PointType })}
          style={{ width: "100%", padding: 6 }}
        >
          {TYPES.map(t => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
      </label>

      <label style={{ display: "block", marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>
          Вес (глубина): {point.weight.toFixed(1)}
        </div>
        <input
          type="range"
          min="0.2"
          max="2.5"
          step="0.1"
          value={point.weight}
          onChange={(e) => onChange({ ...point, weight: parseFloat(e.target.value) })}
          style={{ width: "100%" }}
        />
      </label>

      <button
        onClick={() => onDelete(point.id)}
        style={{ 
          width: "100%", 
          padding: 8, 
          background: "#ffebee", 
          color: "#c62828", 
          border: "1px solid #ef9a9a",
          cursor: "pointer",
          borderRadius: 4
        }}
      >
        Удалить точку
      </button>
    </div>
  );
}