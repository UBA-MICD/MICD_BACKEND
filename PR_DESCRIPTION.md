# PR: Zenodo Import Fix + ZIP Extraction + Upload Fixes

## Resumen

- **Zenodo import**: fix del 422 sin mensaje, detección de duplicados en Orthanc vs DB, soporte de ZIPs vía streaming
- **Upload**: eliminación de validación de magic bytes que rechazaba DICOMs formato ACR-NEMA válidos
- **Timeout**: aumento de 5 min a 30 min para descargas de archivos grandes desde Zenodo

---

## Cambios

### Zenodo Import (`src/modules/zenodo/zenodo-import.service.ts`)

- **Fix duplicado oculto**: cuando un archivo está en Orthanc (`AlreadyStored`) pero no en la DB, ahora lo **inserta** en vez de retornar `duplicate`. Esto ocurría con archivos subidos manualmente que nunca se registraron en la tabla `studies`.
- **Soporte ZIP**: nueva función `importZipFile()` que descarga el ZIP como stream, lo parsea con `unzipper`, bufferiza cada entrada `.dcm` y la envía a Orthanc secuencialmente. Protecciones:
  - Límite de 2 GB descomprimido (anti zip-bomb)
  - Filtro de path traversal (`..` ignorado)
  - Solo archivos `.dcm` extraídos
- `importFromZenodo()` ya no skipea ZIPs — los procesa con `importZipFile()`

### Zenodo Controller (`src/modules/zenodo/zenodo.controller.ts`)

- Respuesta 422 ahora incluye campo `error` con mensaje descriptivo según causa:
  - ZIP skipped → *"Los archivos ZIP no son importables directamente..."* (ahora no debería ocurrir)
  - Archivos fallidos → primer error del resultado
  - Sin importables → mensaje genérico
- Log de resultado final antes de enviar respuesta

### Upload (`src/modules/upload/upload.service.ts`, `upload.controller.ts`)

- Eliminada validación de magic bytes DICOM (`isDicom()` check previo a Orthanc). Orthanc ya es el validador autoritativo y devuelve 400 para archivos inválidos. La validación previa rechazaba DICOMs ACR-NEMA legítimos sin preámbulo de 128 bytes.
- Logs de diagnóstico en controller y service

### Studies (`src/modules/studies/studies.controller.ts`)

- Log de `listStudies` con total, filtros y estudios retornados (diagnóstico)

### Config (`src/config/env.ts`)

- `ZENODO_UPLOAD_TIMEOUT_MS` default aumentado de 300000 (5 min) a 1800000 (30 min) para soportar ZIPs de 1-2 GB

### Dependencias

- `unzipper` agregado como dependencia de producción para extracción de ZIPs

---

## Test plan

- [ ] Importar record Zenodo con `.dcm` → `imported: 1`, aparece en el explorador
- [ ] Importar mismo record → `duplicates: 1`, HTTP 200
- [ ] Archivo en Orthanc pero no en DB → se registra automáticamente, `imported: 1`
- [ ] Importar record con ZIP pequeño → extrae DICOMs internos, aparecen en explorador
- [ ] ZIP con archivos no-DICOM mezclados → solo `.dcm` procesados, resto ignorados
- [ ] ZIP > 2 GB descomprimido → resultado `failed` con mensaje de límite
- [ ] Subir DICOM ACR-NEMA (sin preámbulo) → acepta si Orthanc lo acepta
- [ ] Subir DICOM inválido → Orthanc devuelve 400, frontend muestra error
- [ ] Timeout de 30 min no bloquea descargas de ZIPs grandes
