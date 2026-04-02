import { google } from 'googleapis';

const SPREADSHEET_ID = '1BTIerDgU52ACpAJHjv0aTrs1snUs1BZev6Os6-CyuSo';
const SHEET_NAME = 'Hoja 1';

function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return auth;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { rows, mode } = req.body;
    if (!rows || !Array.length) {
      return res.status(400).json({ error: 'No rows provided' });
    }

    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    // Read existing folios from column B (FOLIO)
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!B:B`,
    });

    const existingFolios = new Set();
    if (existing.data.values) {
      existing.data.values.forEach(row => {
        const val = String(row[0] || '').trim();
        if (val && val !== 'FOLIO') existingFolios.add(val);
      });
    }

    // Filter new rows (folio not in existing)
    const newRows = rows.filter(row => {
      const folio = String(row[1] || '').trim();
      return folio && !existingFolios.has(folio);
    });

    if (newRows.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No hay facturas nuevas para agregar',
        added: 0,
        duplicates: rows.length,
        totalExisting: existingFolios.size,
      });
    }

    // Append new rows
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:F`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: newRows,
      },
    });

    return res.status(200).json({
      success: true,
      message: `Se agregaron ${newRows.length} facturas nuevas`,
      added: newRows.length,
      duplicates: rows.length - newRows.length,
      totalExisting: existingFolios.size,
      newFolios: newRows.map(r => r[1]),
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({
      error: error.message || 'Error interno del servidor',
    });
  }
}
