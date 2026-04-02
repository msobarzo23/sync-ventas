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

function parseXLSFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        // Dynamic import of xlsx library
        const XLSX = await import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm");
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: "array" });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true });
        resolve(jsonData);
      } catch (err) {
        reject(err);
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
  const docIdx = headers.findIndex(h => h.includes("DOCUMENTO") || h.includes("TIPO"));

  if (folioIdx === -1) throw new Error("No se encontró la columna FOLIO");
  if (clienteIdx === -1) throw new Error("No se encontró la columna RAZÓN SOCIAL / CLIENTE");
  if (netoIdx === -1) throw new Error("No se encontró la columna NETO");

  const rows = [];
  for (let i = headerIdx + 1; i < rawData.length; i++) {
    const row = rawData[i];
    if (!row || !Array.isArray(row) || row.length < 2) continue;

    const folio = String(safeGet(row, folioIdx)).trim();
    if (!folio || folio === "TOTAL" || folio.includes("TOTAL GENERAL") || folio === "" || isNaN(parseInt(folio))) continue;

    const cliente = String(safeGet(row, clienteIdx)).trim();
    if (!cliente) continue;

    // Clean client name - remove [CASA MATRIZ], [SUCURSAL], etc.
    const cleanCliente = cliente.replace(/\s*\[.*?\]\s*/g, "").trim();

    let neto = safeGet(row, netoIdx);
    if (typeof neto === "string") {
      neto = neto.replace(/\$/g, "").replace(/\./g, "").replace(/,/g, ".").trim();
      neto = parseFloat(neto) || 0;
    }
    neto = Number(neto) || 0;

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

    let documento = "FACTURA ELECTRONICA";
    if (docIdx >= 0) {
      const docVal = safeGet(row, docIdx);
      if (docVal) documento = String(docVal).toUpperCase().trim();
    }
    // If no document type column found, try to infer from folio range or neto sign
    if (!documento || documento === "") {
      documento = neto < 0 ? "NOTA DE CREDITO ELECTRONICA" : "FACTURA ELECTRONICA";
    }

    // Format neto for Google Sheets (Chilean format with dots)
    const netoFormatted = `$${Math.abs(Math.round(neto)).toLocaleString("es-CL")}`;
    const netoFinal = neto < 0 ? `-${netoFormatted}` : netoFormatted;

    rows.push({
      documento,
      folio,
      fecha,
      rut,
      cliente: cleanCliente,
      neto: neto,
      netoDisplay: netoFinal,
      // Row for Google Sheets: [DOCUMENTO, FOLIO, FECHA, RUT, RAZON SOCIAL, NETO]
      sheetRow: [documento, folio, fecha, rut, cleanCliente, netoFinal],
    });
  }

  return rows;
}

export default function App() {
  const [step, setStep] = useState("upload"); // upload, preview, syncing, done
  const [parsedRows, setParsedRows] = useState([]);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState(null);
  const [syncResult, setSyncResult] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef(null);

  const handleFile = useCallback(async (file) => {
    if (!file) return;
    setError(null);
    setFileName(file.name);

    try {
      const rawData = await parseXLSFile(file);
      const rows = parseFacturacionData(rawData);
      if (rows.length === 0) throw new Error("No se encontraron facturas válidas en el archivo");
      setParsedRows(rows);
      setStep("preview");
    } catch (err) {
      setError(err.message);
    }
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleSync = async () => {
    setStep("syncing");
    setError(null);

    try {
      const response = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: parsedRows.map(r => r.sheetRow),
        }),
      });

      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Error al sincronizar");

      setSyncResult(result);
      setStep("done");
    } catch (err) {
      setError(err.message);
      setStep("preview");
    }
  };

  const reset = () => {
    setStep("upload");
    setParsedRows([]);
    setFileName("");
    setError(null);
    setSyncResult(null);
  };

  const totalNeto = parsedRows.reduce((s, r) => s + r.neto, 0);
  const facturas = parsedRows.filter(r => !r.documento.includes("NOTA DE CREDITO"));
  const notasCredito = parsedRows.filter(r => r.documento.includes("NOTA DE CREDITO"));

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
            <button onClick={handleSync} style={{ padding: "12px 32px", borderRadius: 12, border: "none", background: `linear-gradient(135deg,${C.green},${C.cyan})`, color: "#fff", cursor: "pointer", fontSize: 14, fontWeight: 800, boxShadow: `0 8px 24px ${C.green}40` }}>
              Sincronizar con Google Sheets →
            </button>
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
