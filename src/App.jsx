import { useState, useRef, useCallback } from "react";

const C = {
  bg: "#0c1222", bgCard: "#141d30", bgAlt: "#1a2540",
  border: "#243352",
  blue: "#3b82f6", blueGlow: "#60a5fa",
  cyan: "#22d3ee", amber: "#f59e0b", green: "#10b981", red: "#f43f5e",
  text: "#f1f5f9", sub: "#94a3b8", dim: "#64748b", faint: "#475569",
};

const fmtF = (n) => {
  if (n == null || isNaN(n)) return "$0";
  return `${n < 0 ? "-" : ""}$${Math.abs(Math.round(n)).toLocaleString("es-CL")}`;
};

function loadXLSXLibrary() {
  return new Promise((resolve, reject) => {
    if (window.XLSX) { resolve(window.XLSX); return; }
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
    script.onload = () => {
      if (window.XLSX) resolve(window.XLSX);
      else reject(new Error("No se pudo cargar la librería XLSX"));
    };
    script.onerror = () => reject(new Error("Error descargando librería XLSX"));
    document.head.appendChild(script);
  });
}

function parseXLSFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const XLSX = await loadXLSXLibrary();
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: "array" });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });
        resolve(jsonData);
      } catch (err) {
        reject(new Error(`Error procesando archivo: ${err.message}`));
      }
    };
    reader.onerror = () => reject(new Error("Error leyendo archivo"));
    reader.readAsArrayBuffer(file);
  });
}

function findHeaderRow(data) {
  for (let i = 0; i < Math.min(data.length, 30); i++) {
    const row = data[i];
    if (!row || !Array.isArray(row)) continue;
    const cells = row.map(c => String(c ?? "").toUpperCase().trim());
    const hasfolio = cells.some(c => c === "FOLIO");
    const hasCliente = cells.some(c => c.includes("RAZON") || c.includes("RAZÓN") || c.includes("CLIENTE"));
    if (hasfolio && hasCliente) return i;
  }
  return -1;
}

function safeGet(row, idx) {
  if (idx < 0 || !row || idx >= row.length) return "";
  return row[idx] ?? "";
}

function parseFacturacionData(rawData) {
  const headerIdx = findHeaderRow(rawData);
  if (headerIdx === -1) throw new Error("No se encontraron las columnas FOLIO y RAZÓN SOCIAL en el archivo. Asegúrate de subir el Excel del Libro de Ventas de facturacion.cl");

  const headerRow = rawData[headerIdx] || [];
  const headers = headerRow.map(h => String(h ?? "").toUpperCase().trim());

  // Find column indices
  const folioIdx = headers.findIndex(h => h === "FOLIO");
  const fechaIdx = headers.findIndex(h => h.includes("FECHA") || h.includes("EMISI"));
  const rutIdx = headers.findIndex(h => h === "RUT" || h.includes("R.U.T"));
  const clienteIdx = headers.findIndex(h => h.includes("RAZON") || h.includes("RAZÓN") || h.includes("CLIENTE"));
  const netoIdx = headers.findIndex(h => h === "NETO");
  const exentoIdx = headers.findIndex(h => h === "EXENTO");
  const totalIdx = headers.findIndex(h => h === "TOTAL");
  const docIdx = headers.findIndex(h => h.includes("DOCUMENTO") || h.includes("TIPO"));

  if (folioIdx === -1) throw new Error("No se encontró la columna FOLIO");
  if (clienteIdx === -1) throw new Error("No se encontró la columna RAZÓN SOCIAL / CLIENTE");
  if (netoIdx === -1 && totalIdx === -1) throw new Error("No se encontró la columna NETO ni TOTAL");

  // Known document type section headers in facturacion.cl exports
  const DOC_TYPES = [
    "FACTURA ELECTRONICA",
    "FACTURA NO AFECTA O EXENTA ELECTRONICA", 
    "NOTA DE CREDITO ELECTRONICA",
    "NOTA DE DEBITO ELECTRONICA",
    "LIQUIDACION FACTURA ELECTRONICA",
    "GUIA DE DESPACHO ELECTRONICA",
  ];

  const rows = [];
  let currentDocType = "FACTURA ELECTRONICA"; // default

  for (let i = headerIdx + 1; i < rawData.length; i++) {
    const row = rawData[i];
    if (!row || !Array.isArray(row) || row.length < 1) continue;

    // Check if this row is a document type section header
    // In facturacion.cl exports, the doc type can appear in any cell
    // Check ALL cells in the row for a document type match
    let isDocTypeRow = false;
    for (let c = 0; c < Math.min(row.length, 10); c++) {
      const cellVal = String(row[c] ?? "").toUpperCase().trim();
      if (!cellVal) continue;
      const matchedType = DOC_TYPES.find(dt => cellVal === dt || cellVal.includes(dt));
      if (matchedType) {
        currentDocType = matchedType;
        isDocTypeRow = true;
        break;
      }
    }
    if (isDocTypeRow) continue;

    // Skip total/summary rows - check all cells
    const allCellsText = row.map(c => String(c ?? "").toUpperCase().trim()).join(" ");
    if (allCellsText.includes("TOTAL") || allCellsText.includes("SUBTOTAL")) continue;

    const folio = String(safeGet(row, folioIdx)).trim();
    if (!folio || folio === "" || isNaN(parseInt(folio))) continue;

    const cliente = String(safeGet(row, clienteIdx)).trim();
    if (!cliente) continue;

    // Clean client name - remove [CASA MATRIZ], [SUCURSAL], etc.
    const cleanCliente = cliente.replace(/\s*\[.*?\]\s*/g, "").trim();

    // Parse amount - helper that handles parentheses (negative) format
    function parseAmountCell(val) {
      if (val === null || val === undefined || val === "") return 0;
      if (typeof val === "number") return val;
      let s = String(val).trim();
      // Handle parentheses notation for negatives: (4800000) = -4800000
      const isNegParens = s.startsWith("(") && s.endsWith(")");
      if (isNegParens) s = s.slice(1, -1);
      s = s.replace(/\$/g, "").replace(/\./g, "").replace(/,/g, ".").trim();
      let num = parseFloat(s) || 0;
      if (isNegParens && num > 0) num = -num;
      return num;
    }

    // Try NETO column first, if 0 try EXENTO, if still 0 try TOTAL
    let neto = parseAmountCell(safeGet(row, netoIdx));
    if (neto === 0 && exentoIdx >= 0) {
      neto = parseAmountCell(safeGet(row, exentoIdx));
    }
    if (neto === 0 && totalIdx >= 0) {
      // For total, we need to extract the neto part (total includes IVA)
      // But if neto and exento are both 0, use total as fallback
      neto = parseAmountCell(safeGet(row, totalIdx));
    }

    let fecha = "";
    if (fechaIdx >= 0) {
      const rawFecha = safeGet(row, fechaIdx);
      if (rawFecha) {
        if (typeof rawFecha === "number") {
          // Excel serial date
          const d = new Date((rawFecha - 25569) * 86400000);
          fecha = `${d.getDate()}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
        } else {
          // Parse text date like "31 de Marzo de 2026" or "02/04/26"
          const s = String(rawFecha).trim();
          const meses = { enero: "01", febrero: "02", marzo: "03", abril: "04", mayo: "05", junio: "06", julio: "07", agosto: "08", septiembre: "09", octubre: "10", noviembre: "11", diciembre: "12" };
          const match = s.match(/(\d{1,2})\s+de\s+(\w+)\s+de\s+(\d{4})/i);
          if (match) {
            const [, day, monthName, year] = match;
            const mm = meses[monthName.toLowerCase()] || "01";
            fecha = `${parseInt(day)}/${mm}/${year}`;
          } else if (s.includes("/")) {
            const parts = s.split("/");
            if (parts.length === 3) {
              let [d, m, y] = parts;
              if (y.length === 2) y = "20" + y;
              fecha = `${parseInt(d)}/${m.padStart(2, "0")}/${y}`;
            }
          } else {
            fecha = s;
          }
        }
      }
    }

    let rut = "";
    if (rutIdx >= 0) {
      const rutVal = safeGet(row, rutIdx);
      if (rutVal) rut = String(rutVal).trim();
    }

    let documento = currentDocType;
    // For notas de credito, ensure neto is negative
    if (documento.includes("NOTA DE CREDITO") && neto > 0) {
      neto = -neto;
    }

    // Format for display only
    const netoFormatted = `$${Math.abs(Math.round(neto)).toLocaleString("es-CL")}`;
    const netoDisplay = neto < 0 ? `-${netoFormatted}` : netoFormatted;

    rows.push({
      documento,
      folio,
      fecha,
      rut,
      cliente: cleanCliente,
      neto: neto,
      netoDisplay: netoDisplay,
      // Row for Google Sheets: send NETO as raw number so Sheets treats it as numeric
      sheetRow: [documento, folio, fecha, rut, cleanCliente, Math.round(neto)],
    });
  }

  return rows;
}

export default function App() {
  const [step, setStep] = useState("upload"); // upload, preview, checking, select, syncing, done
  const [parsedRows, setParsedRows] = useState([]);
  const [newRows, setNewRows] = useState([]); // rows not in sheet yet
  const [selectedFolios, setSelectedFolios] = useState(new Set()); // folios user wants to sync
  const [existingCount, setExistingCount] = useState(0);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState(null);
  const [syncResult, setSyncResult] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef(null);
  const [loading, setLoading] = useState(false);

  const handleFile = useCallback(async (file) => {
    if (!file) return;
    setError(null);
    setFileName(file.name);
    setLoading(true);

    try {
      const rawData = await parseXLSFile(file);
      if (!rawData || rawData.length === 0) throw new Error("El archivo está vacío o no se pudo leer");
      console.log("Raw data rows:", rawData.length);
      const rows = parseFacturacionData(rawData);
      console.log("Parsed rows:", rows.length, "Types:", [...new Set(rows.map(r => r.documento))]);
      if (rows.length === 0) throw new Error("No se encontraron facturas válidas en el archivo");
      setParsedRows(rows);
      setStep("preview");
    } catch (err) {
      setError(err.message || "Error desconocido al procesar el archivo");
    } finally {
      setLoading(false);
    }
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  // Step 2: Check which rows are new (not in Google Sheet)
  const handleCheckNew = async () => {
    setStep("checking");
    setError(null);
    try {
      const response = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: parsedRows.map(r => r.sheetRow), mode: "check" }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Error al verificar");

      const existingFolios = new Set(result.existingFolios || []);
      const filtered = parsedRows.filter(r => !existingFolios.has(String(r.folio)));
      setNewRows(filtered);
      setExistingCount(parsedRows.length - filtered.length);
      // Select all by default
      setSelectedFolios(new Set(filtered.map(r => r.folio)));
      setStep("select");
    } catch (err) {
      setError(err.message);
      setStep("preview");
    }
  };

  // Step 3: Sync only selected rows
  const handleSync = async () => {
    const rowsToSync = newRows.filter(r => selectedFolios.has(r.folio));
    if (rowsToSync.length === 0) {
      setError("No hay facturas seleccionadas para sincronizar");
      return;
    }
    setStep("syncing");
    setError(null);

    try {
      const response = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: rowsToSync.map(r => r.sheetRow), mode: "write" }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Error al sincronizar");
      setSyncResult({ ...result, skippedByUser: newRows.length - rowsToSync.length });
      setStep("done");
    } catch (err) {
      setError(err.message);
      setStep("select");
    }
  };

  const toggleFolio = (folio) => {
    setSelectedFolios(prev => {
      const next = new Set(prev);
      if (next.has(folio)) next.delete(folio);
      else next.add(folio);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedFolios.size === newRows.length) {
      setSelectedFolios(new Set());
    } else {
      setSelectedFolios(new Set(newRows.map(r => r.folio)));
    }
  };

  const reset = () => {
    setStep("upload");
    setParsedRows([]);
    setNewRows([]);
    setSelectedFolios(new Set());
    setFileName("");
    setError(null);
    setSyncResult(null);
  };

  const totalNeto = parsedRows.reduce((s, r) => s + r.neto, 0);
  const facturas = parsedRows.filter(r => !r.documento.includes("NOTA DE CREDITO"));
  const notasCredito = parsedRows.filter(r => r.documento.includes("NOTA DE CREDITO"));
  const selectedNeto = newRows.filter(r => selectedFolios.has(r.folio)).reduce((s, r) => s + r.neto, 0);

  return (
    <div style={{ fontFamily: "'Manrope',system-ui,sans-serif", background: C.bg, minHeight: "100vh", color: C.text, display: "flex", flexDirection: "column", alignItems: "center", padding: "24px 16px" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap');*{box-sizing:border-box;margin:0;padding:0}::-webkit-scrollbar{width:5px;height:5px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:${C.border};border-radius:3px}`}</style>

      {/* Header */}
      <div style={{ textAlign: "center", marginBottom: 32, maxWidth: 600 }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <div style={{ width: 40, height: 40, borderRadius: 12, background: `linear-gradient(135deg,${C.green},${C.cyan})`, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 18, color: "#fff" }}>S</div>
          <div style={{ textAlign: "left" }}>
            <div style={{ fontWeight: 800, fontSize: 18 }}>Sync Ventas</div>
            <div style={{ fontSize: 11, color: C.dim }}>Facturación → Google Sheets</div>
          </div>
        </div>
        <p style={{ color: C.sub, fontSize: 13, lineHeight: 1.6 }}>
          Sube el Excel exportado desde facturacion.cl y sincroniza automáticamente con tu hoja de cálculo.
        </p>
      </div>

      {error && (
        <div style={{ background: `${C.red}14`, border: `1px solid ${C.red}44`, color: "#fecdd3", padding: "12px 16px", borderRadius: 12, fontSize: 13, marginBottom: 20, maxWidth: 600, width: "100%" }}>
          {error}
        </div>
      )}

      {/* STEP: Upload */}
      {step === "upload" && (
        loading ? (
          <div style={{ textAlign: "center", padding: 60 }}>
            <div style={{ width: 44, height: 44, border: `3px solid ${C.border}`, borderTopColor: C.green, borderRadius: "50%", animation: "spin .8s linear infinite", margin: "0 auto 18px" }} />
            <div style={{ color: C.sub, fontSize: 14 }}>Procesando archivo...</div>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        ) : (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileRef.current?.click()}
          style={{
            background: dragOver ? `${C.green}12` : C.bgCard,
            border: `2px dashed ${dragOver ? C.green : C.border}`,
            borderRadius: 20, padding: "60px 40px", maxWidth: 500, width: "100%",
            textAlign: "center", cursor: "pointer", transition: "all 0.2s",
          }}
        >
          <input ref={fileRef} type="file" accept=".xls,.xlsx,.csv" onChange={(e) => handleFile(e.target.files[0])} style={{ display: "none" }} />
          <div style={{ fontSize: 48, marginBottom: 16 }}>📄</div>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 16, marginBottom: 8 }}>
            Arrastra tu archivo Excel aquí
          </div>
          <div style={{ color: C.dim, fontSize: 13, marginBottom: 20 }}>
            o haz clic para seleccionar
          </div>
          <div style={{ color: C.faint, fontSize: 11 }}>
            Archivos .xls o .xlsx exportados desde facturacion.cl
          </div>
        </div>
        )
      )}

      {/* STEP: Preview */}
      {step === "preview" && (
        <div style={{ maxWidth: 900, width: "100%" }}>
          {/* Summary cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 20 }}>
            <div style={{ background: C.bgCard, borderRadius: 14, padding: "16px 18px", border: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 11, color: C.dim, fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>Archivo</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.text, wordBreak: "break-all" }}>{fileName}</div>
            </div>
            <div style={{ background: C.bgCard, borderRadius: 14, padding: "16px 18px", border: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 11, color: C.dim, fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>Documentos</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: C.text }}>{parsedRows.length}</div>
            </div>
            <div style={{ background: C.bgCard, borderRadius: 14, padding: "16px 18px", border: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 11, color: C.dim, fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>Facturas</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: C.green }}>{facturas.length}</div>
            </div>
            <div style={{ background: C.bgCard, borderRadius: 14, padding: "16px 18px", border: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 11, color: C.dim, fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>Notas de crédito</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: C.red }}>{notasCredito.length}</div>
            </div>
            <div style={{ background: C.bgCard, borderRadius: 14, padding: "16px 18px", border: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 11, color: C.dim, fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>Neto total</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: totalNeto >= 0 ? C.green : C.red }}>{fmtF(totalNeto)}</div>
            </div>
          </div>

          {/* Preview table */}
          <div style={{ background: C.bgCard, borderRadius: 14, border: `1px solid ${C.border}`, overflow: "hidden", marginBottom: 20 }}>
            <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.border}` }}>
              <h3 style={{ fontSize: 14, fontWeight: 700 }}>Vista previa de datos</h3>
            </div>
            <div style={{ overflowX: "auto", maxHeight: 400 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead style={{ position: "sticky", top: 0, zIndex: 2 }}>
                  <tr>
                    {["Tipo", "Folio", "Fecha", "RUT", "Razón Social", "Neto"].map(h => (
                      <th key={h} style={{ padding: "8px 10px", textAlign: h === "Neto" ? "right" : "left", color: C.dim, fontWeight: 700, borderBottom: `2px solid ${C.border}`, fontSize: 10, textTransform: "uppercase", background: C.bgCard, whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {parsedRows.slice(0, 100).map((r, i) => (
                    <tr key={i} style={{ background: i % 2 ? C.bgAlt : "transparent" }}>
                      <td style={{ padding: "7px 10px", color: C.dim, fontSize: 11 }}>{r.documento}</td>
                      <td style={{ padding: "7px 10px", color: C.blueGlow, fontWeight: 700, fontFamily: "monospace" }}>{r.folio}</td>
                      <td style={{ padding: "7px 10px", color: C.sub }}>{r.fecha}</td>
                      <td style={{ padding: "7px 10px", color: C.dim, fontSize: 11 }}>{r.rut}</td>
                      <td style={{ padding: "7px 10px", color: C.text, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.cliente}</td>
                      <td style={{ padding: "7px 10px", textAlign: "right", color: r.neto >= 0 ? C.text : C.red, fontWeight: 700 }}>{fmtF(r.neto)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {parsedRows.length > 100 && (
              <div style={{ padding: "10px 18px", color: C.dim, fontSize: 11, borderTop: `1px solid ${C.border}` }}>
                Mostrando 100 de {parsedRows.length} registros
              </div>
            )}
          </div>

          {/* Action buttons */}
          <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
            <button onClick={reset} style={{ padding: "12px 24px", borderRadius: 12, border: `1px solid ${C.border}`, background: C.bgAlt, color: C.sub, cursor: "pointer", fontSize: 14, fontWeight: 700 }}>
              ← Cancelar
            </button>
            <button onClick={handleCheckNew} style={{ padding: "12px 32px", borderRadius: 12, border: "none", background: `linear-gradient(135deg,${C.green},${C.cyan})`, color: "#fff", cursor: "pointer", fontSize: 14, fontWeight: 800, boxShadow: `0 8px 24px ${C.green}40` }}>
              Verificar nuevas facturas →
            </button>
          </div>
        </div>
      )}

      {/* STEP: Checking */}
      {step === "checking" && (
        <div style={{ textAlign: "center", padding: 40 }}>
          <div style={{ width: 48, height: 48, border: `3px solid ${C.border}`, borderTopColor: C.green, borderRadius: "50%", animation: "spin .8s linear infinite", margin: "0 auto 20px" }} />
          <div style={{ color: C.sub, fontSize: 15, fontWeight: 600 }}>Verificando con Google Sheets...</div>
          <div style={{ color: C.dim, fontSize: 12, marginTop: 8 }}>Comparando folios existentes</div>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}

      {/* STEP: Select which rows to sync */}
      {step === "select" && (
        <div style={{ maxWidth: 900, width: "100%" }}>
          {/* Summary */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 20 }}>
            <div style={{ background: C.bgCard, borderRadius: 14, padding: "16px 18px", border: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 11, color: C.dim, fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>En el archivo</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: C.text }}>{parsedRows.length}</div>
            </div>
            <div style={{ background: C.bgCard, borderRadius: 14, padding: "16px 18px", border: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 11, color: C.dim, fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>Ya en la hoja</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: C.amber }}>{existingCount}</div>
            </div>
            <div style={{ background: C.bgCard, borderRadius: 14, padding: "16px 18px", border: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 11, color: C.dim, fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>Nuevas</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: C.green }}>{newRows.length}</div>
            </div>
            <div style={{ background: C.bgCard, borderRadius: 14, padding: "16px 18px", border: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 11, color: C.dim, fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>Seleccionadas</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: C.cyan }}>{selectedFolios.size}</div>
            </div>
            <div style={{ background: C.bgCard, borderRadius: 14, padding: "16px 18px", border: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 11, color: C.dim, fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>Neto seleccionado</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: selectedNeto >= 0 ? C.green : C.red }}>{fmtF(selectedNeto)}</div>
            </div>
          </div>

          {newRows.length === 0 ? (
            <div style={{ background: C.bgCard, borderRadius: 14, padding: 40, border: `1px solid ${C.border}`, textAlign: "center", marginBottom: 20 }}>
              <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
              <h3 style={{ fontSize: 18, fontWeight: 800, marginBottom: 8 }}>Todo al día</h3>
              <p style={{ color: C.sub, fontSize: 14 }}>Todas las facturas del archivo ya están en tu Google Sheet.</p>
            </div>
          ) : (
            <div style={{ background: C.bgCard, borderRadius: 14, border: `1px solid ${C.border}`, overflow: "hidden", marginBottom: 20 }}>
              <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
                <h3 style={{ fontSize: 14, fontWeight: 700 }}>Facturas nuevas — selecciona las que quieres agregar</h3>
                <button onClick={toggleAll} style={{ padding: "6px 14px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.bgAlt, color: C.sub, cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
                  {selectedFolios.size === newRows.length ? "Deseleccionar todas" : "Seleccionar todas"}
                </button>
              </div>
              <div style={{ overflowX: "auto", maxHeight: 450 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead style={{ position: "sticky", top: 0, zIndex: 2 }}>
                    <tr>
                      <th style={{ padding: "8px 10px", width: 40, textAlign: "center", background: C.bgCard, borderBottom: `2px solid ${C.border}` }}>
                        <input type="checkbox" checked={selectedFolios.size === newRows.length && newRows.length > 0} onChange={toggleAll} style={{ cursor: "pointer", width: 16, height: 16, accentColor: C.green }} />
                      </th>
                      {["Tipo", "Folio", "Fecha", "Razón Social", "Neto"].map(h => (
                        <th key={h} style={{ padding: "8px 10px", textAlign: h === "Neto" ? "right" : "left", color: C.dim, fontWeight: 700, borderBottom: `2px solid ${C.border}`, fontSize: 10, textTransform: "uppercase", background: C.bgCard, whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {newRows.map((r, i) => {
                      const isSelected = selectedFolios.has(r.folio);
                      return (
                        <tr key={r.folio} onClick={() => toggleFolio(r.folio)} style={{ background: isSelected ? (i % 2 ? C.bgAlt : "transparent") : `${C.red}08`, cursor: "pointer", opacity: isSelected ? 1 : 0.5, transition: "all 0.15s" }}>
                          <td style={{ padding: "7px 10px", textAlign: "center" }}>
                            <input type="checkbox" checked={isSelected} onChange={() => toggleFolio(r.folio)} style={{ cursor: "pointer", width: 16, height: 16, accentColor: C.green }} />
                          </td>
                          <td style={{ padding: "7px 10px", color: C.dim, fontSize: 11 }}>{r.documento}</td>
                          <td style={{ padding: "7px 10px", color: C.blueGlow, fontWeight: 700, fontFamily: "monospace" }}>{r.folio}</td>
                          <td style={{ padding: "7px 10px", color: C.sub }}>{r.fecha}</td>
                          <td style={{ padding: "7px 10px", color: C.text, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.cliente}</td>
                          <td style={{ padding: "7px 10px", textAlign: "right", color: r.neto >= 0 ? C.text : C.red, fontWeight: 700 }}>{fmtF(r.neto)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
            <button onClick={reset} style={{ padding: "12px 24px", borderRadius: 12, border: `1px solid ${C.border}`, background: C.bgAlt, color: C.sub, cursor: "pointer", fontSize: 14, fontWeight: 700 }}>
              ← Cancelar
            </button>
            {newRows.length > 0 && (
              <button onClick={handleSync} disabled={selectedFolios.size === 0} style={{ padding: "12px 32px", borderRadius: 12, border: "none", background: selectedFolios.size > 0 ? `linear-gradient(135deg,${C.green},${C.cyan})` : C.bgAlt, color: selectedFolios.size > 0 ? "#fff" : C.dim, cursor: selectedFolios.size > 0 ? "pointer" : "default", fontSize: 14, fontWeight: 800, boxShadow: selectedFolios.size > 0 ? `0 8px 24px ${C.green}40` : "none" }}>
                Sincronizar {selectedFolios.size} facturas →
              </button>
            )}
          </div>
        </div>
      )}

      {/* STEP: Syncing */}
      {step === "syncing" && (
        <div style={{ textAlign: "center", padding: 40 }}>
          <div style={{ width: 48, height: 48, border: `3px solid ${C.border}`, borderTopColor: C.green, borderRadius: "50%", animation: "spin .8s linear infinite", margin: "0 auto 20px" }} />
          <div style={{ color: C.sub, fontSize: 15, fontWeight: 600 }}>Sincronizando con Google Sheets...</div>
          <div style={{ color: C.dim, fontSize: 12, marginTop: 8 }}>Comparando folios y agregando facturas nuevas</div>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}

      {/* STEP: Done */}
      {step === "done" && syncResult && (
        <div style={{ maxWidth: 500, width: "100%", textAlign: "center" }}>
          <div style={{ background: C.bgCard, borderRadius: 20, padding: "40px 32px", border: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 56, marginBottom: 16 }}>{syncResult.added > 0 ? "✅" : "ℹ️"}</div>
            <h2 style={{ fontSize: 20, fontWeight: 800, marginBottom: 12 }}>
              {syncResult.added > 0 ? "¡Sincronización exitosa!" : "Todo al día"}
            </h2>
            <p style={{ color: C.sub, fontSize: 14, marginBottom: 24, lineHeight: 1.6 }}>
              {syncResult.message}
            </p>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 24 }}>
              <div style={{ background: C.bgAlt, borderRadius: 12, padding: 16 }}>
                <div style={{ fontSize: 11, color: C.dim, textTransform: "uppercase", fontWeight: 700, marginBottom: 4 }}>Agregadas</div>
                <div style={{ fontSize: 28, fontWeight: 800, color: C.green }}>{syncResult.added}</div>
              </div>
              <div style={{ background: C.bgAlt, borderRadius: 12, padding: 16 }}>
                <div style={{ fontSize: 11, color: C.dim, textTransform: "uppercase", fontWeight: 700, marginBottom: 4 }}>Ya existían</div>
                <div style={{ fontSize: 28, fontWeight: 800, color: C.amber }}>{syncResult.duplicates}</div>
              </div>
            </div>

            {syncResult.added > 0 && syncResult.newFolios && (
              <div style={{ background: C.bgAlt, borderRadius: 12, padding: "12px 16px", marginBottom: 24, textAlign: "left" }}>
                <div style={{ fontSize: 11, color: C.dim, fontWeight: 700, marginBottom: 6 }}>FOLIOS AGREGADOS:</div>
                <div style={{ fontSize: 12, color: C.blueGlow, fontFamily: "monospace", lineHeight: 1.8, wordBreak: "break-all" }}>
                  {syncResult.newFolios.join(", ")}
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
              <button onClick={reset} style={{ padding: "12px 24px", borderRadius: 12, border: `1px solid ${C.border}`, background: C.bgAlt, color: C.sub, cursor: "pointer", fontSize: 14, fontWeight: 700 }}>
                Subir otro archivo
              </button>
              <a href="https://dashboard-ventas-seven.vercel.app" target="_blank" rel="noopener noreferrer" style={{ padding: "12px 24px", borderRadius: 12, border: "none", background: `linear-gradient(135deg,${C.blue},${C.cyan})`, color: "#fff", cursor: "pointer", fontSize: 14, fontWeight: 800, textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
                Ver Dashboard →
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
