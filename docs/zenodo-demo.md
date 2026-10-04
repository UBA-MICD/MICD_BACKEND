# Demo — Integración Zenodo en MICD

Tiempo estimado: **15–20 minutos**. Todos los comandos apuntan a `http://localhost:3000` (stack levantado con `make up`).

---

## Antes de empezar

```bash
# 1. Levantar el stack
cd ~/Desktop/MICD_BACKEND
make up

# 2. Obtener token de sesión (guardarlo en $TOKEN para todos los pasos)
TOKEN=$(curl -s http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@micd.local","password":"testpassword"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken'])")
echo $TOKEN   # debe imprimir un JWT
```

---

## Paso 1 — Gestión de credenciales

**Qué muestra:** los tokens Zenodo se guardan cifrados (AES-256-GCM) en la base de datos. Nunca se expone el token completo, solo un hint de los últimos 4 caracteres.

```bash
# Ver estado actual (sandbox ya configurado, production vacío)
curl -s http://localhost:3000/api/v1/zenodo/config/status \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

Respuesta esperada:
```json
{
  "sandbox": { "configured": true, "hint": "xxxx...MRSA", "last_updated": "..." },
  "production": { "configured": false, "hint": null, "last_updated": null }
}
```

```bash
# Guardar (o reemplazar) un token
curl -s -X POST http://localhost:3000/api/v1/zenodo/config \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"environment": "sandbox", "token": "TU_TOKEN_SANDBOX"}' \
  | python3 -m json.tool
```

Respuesta esperada:
```json
{ "status": "connected", "environment": "sandbox", "hint": "xxxx...MRSA" }
```

> El sistema verifica la conectividad con Zenodo al guardar el token y luego cada hora de forma automática.

---

## Paso 2 — Búsqueda en el catálogo público de Zenodo

**Qué muestra:** desde MICD se puede buscar datasets DICOM publicados en Zenodo, con filtros por tipo de archivo, fecha y licencia. No requiere que el usuario esté autenticado en Zenodo — el sistema usa su propio token para mejorar el rate limit.

```bash
# Búsqueda básica
curl -s "http://localhost:3000/api/v1/zenodo/search?q=CT+DICOM&environment=sandbox&size=5" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

```bash
# Con filtros: solo archivos .dcm, rango de fechas
curl -s "http://localhost:3000/api/v1/zenodo/search?q=CT&environment=sandbox&file_type=dcm&date_from=2023-01-01&size=5" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

Cada resultado incluye `importable: true/false` — indica si el dataset tiene archivos `.dcm` o `.zip` que el sistema puede importar directamente.

```bash
# Detalle de un record específico (con lista de archivos)
curl -s "http://localhost:3000/api/v1/zenodo/records/101651?environment=sandbox" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

```bash
# Búsqueda sin resultados (muestra sugerencias)
curl -s "http://localhost:3000/api/v1/zenodo/search?q=xyzthiswillnevermatch&environment=sandbox" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

---

## Paso 3 — Publicación de estudio anonimizado

**Qué muestra:** un estudio DICOM que ya está en el servidor MICD puede publicarse en Zenodo con un DOI. El sistema verifica que el estudio esté anonimizado antes de subir nada.

El sistema ya tiene un estudio publicado de prueba. Ver su estado:

```bash
# Ver estudios en la base de datos (el primero ya tiene zenodo_doi)
curl -s "http://localhost:3000/api/v1/studies" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

```bash
# Ver el estado del deposition publicado
curl -s "http://localhost:3000/api/v1/zenodo/depositions/1" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

Para publicar un estudio nuevo (requiere subir el DICOM **ya anonimizado** por la API: la ingesta verifica los tags y sólo entonces completa `anonymized_at`):

```bash
curl -s -X POST http://localhost:3000/api/v1/zenodo/publish \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "orthanc_study_id": "6fbf0b01-6c97a45c-6ba1f385-136ebe7e-98953809",
    "environment": "sandbox",
    "title": "CT Scan de prueba — MICD Demo",
    "description": "Dataset anonimizado generado durante la demo de integración Zenodo.",
    "authors": [{ "name": "Demo, MICD", "affiliation": "UBA" }],
    "keywords": ["CT", "DICOM", "demo"],
    "license": "cc-by-4.0"
  }' | python3 -m json.tool
```

**Error esperado si el estudio no está anonimizado:**
```json
{ "error": "El estudio no está anonimizado", "code": "not_anonymized" }
```

**Error esperado si no hay token configurado:**
```json
{ "error": "...", "code": "no_credentials" }
```

---

## Paso 4 — Importación desde Zenodo a Orthanc

**Qué muestra:** los archivos DICOM se streamean directamente desde Zenodo a Orthanc — sin buffering en memoria. El sistema registra la proveniencia (record_id, DOI, versión) en cada estudio importado.

```bash
# Importar el archivo del estudio publicado en el paso 3
curl -s -X POST http://localhost:3000/api/v1/zenodo/import \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "record_id": 561205,
    "environment": "sandbox",
    "files": [
      { "fileKey": "2339bb3d-902b7d65-a57dcdd6-4c4a1e0a-e5fb37fe.dcm" }
    ],
    "overwrite_duplicates": false
  }' | python3 -m json.tool
```

```bash
# Correr de nuevo sin overwrite → debe detectar el duplicado
curl -s -X POST http://localhost:3000/api/v1/zenodo/import \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "record_id": 561205,
    "environment": "sandbox",
    "files": [{ "fileKey": "2339bb3d-902b7d65-a57dcdd6-4c4a1e0a-e5fb37fe.dcm" }],
    "overwrite_duplicates": false
  }' | python3 -m json.tool
# Esperado: { "duplicates": 1, "imported": 0, "failed": 0 }
```

```bash
# Ver estado del import job
curl -s "http://localhost:3000/api/v1/zenodo/imports/1" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

---

## Paso 5 — Sincronización de versiones

**Qué muestra:** el sistema corre automáticamente un cron (configurable en 6/12/24/168 horas) que detecta si algún record de Zenodo del que se importaron estudios tiene una versión nueva disponible, y lo marca en la base de datos.

```bash
# Ver configuración actual del cron
curl -s "http://localhost:3000/api/v1/zenodo/config/sync" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

```bash
# Disparar sincronización manualmente
curl -s -X POST "http://localhost:3000/api/v1/zenodo/config/sync/run" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
# Esperado: { "log_id": N, "records_checked": N, "new_versions": N, "errors": 0 }
```

```bash
# Ver historial de runs
curl -s "http://localhost:3000/api/v1/zenodo/config/sync/logs?limit=5" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

```bash
# Cambiar el intervalo a cada 12 horas
curl -s -X PUT "http://localhost:3000/api/v1/zenodo/config/sync" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"interval_hours": 12}' | python3 -m json.tool

# Deshabilitar el cron automático (los triggers manuales siguen funcionando)
curl -s -X PUT "http://localhost:3000/api/v1/zenodo/config/sync" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"interval_hours": null}' | python3 -m json.tool
```

---

## Paso 6 — Cuota y rate limiting

**Qué muestra:** el sistema estima el uso de almacenamiento en Zenodo a partir de los archivos subidos localmente y alerta al llegar al 90% del límite. El rate limiting es compartido entre todos los procesos (contador en DB), a 50 requests/minuto.

```bash
curl -s "http://localhost:3000/api/v1/zenodo/quota?environment=sandbox" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

Respuesta esperada:
```json
{
  "environment": "sandbox",
  "used_bytes": 9084,
  "limit_bytes": 53687091200,
  "percent_used": 0,
  "alert": false,
  "alert_message": null,
  "rate_limit": {
    "requests_last_minute": 0,
    "throttle_at": 50,
    "limit": 60
  }
}
```

---

## Tests automatizados

```bash
# Correr todos los tests unitarios de Zenodo (66 tests, 7 suites)
npx jest --testPathPatterns="zenodo" --no-coverage

# Solo rate limiting
npx jest --testPathPatterns="zenodo-rate-limit" --no-coverage
```
