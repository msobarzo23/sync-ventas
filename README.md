# Sync Ventas

Herramienta para sincronizar facturas desde facturacion.cl a Google Sheets.

## Configuración en Vercel

### 1. Crear repositorio en GitHub
Sube estos archivos a un nuevo repositorio llamado `sync-ventas`.

### 2. Importar en Vercel
- Ve a vercel.com → Add New Project → Importa `sync-ventas`
- Framework: Vite

### 3. Configurar variable de entorno (IMPORTANTE)
En Vercel, ve a tu proyecto → Settings → Environment Variables:
- Name: `GOOGLE_SERVICE_ACCOUNT_KEY`
- Value: pega el contenido COMPLETO de tu archivo JSON de credenciales
- Haz clic en Save

### 4. Redesplegar
Después de agregar la variable, ve a Deployments → haz clic en los 3 puntos del último deploy → Redeploy.

## Uso
1. Abre la URL de tu herramienta
2. Descarga el Excel del mes desde facturacion.cl
3. Arrastra o selecciona el archivo
4. Revisa los datos en la vista previa
5. Haz clic en "Sincronizar con Google Sheets"
6. ¡Listo! Solo se agregan facturas nuevas (sin duplicados)
