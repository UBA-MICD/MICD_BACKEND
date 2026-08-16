# Guía: Reset y Re-carga de Datos de Prueba

Esta guía explica el flujo y los mecanismos para limpiar, regenerar y re-ingestar datos médicos en formato DICOM dentro de la base de datos de PostgreSQL y el PACS de Orthanc.

---

## 1. Comportamiento y Garantía de Idempotencia

El backend de MICD está diseñado para que el proceso de ingesta sea estrictamente **idempotente**. Si un cliente o el proceso de seeding envía un archivo DICOM que ya ha sido procesado previamente, el sistema reacciona de la siguiente forma:

### PACS (Orthanc)

Orthanc detecta si la instancia ya está guardada basándose en su hash interno. Si ya existe, descarta la subida y responde con un código de estado informando que la instancia ya estaba almacenada.

### Base de Datos (PostgreSQL)

Para evitar registros huérfanos o duplicados a nivel relacional, la tabla `studies` cuenta con una restricción única (`UNIQUE`) sobre la columna `sop_instance_uid` (identificador único a nivel de archivo/corte).

Cuando se realiza un `INSERT`, el backend utiliza la sintaxis **`ON CONFLICT (sop_instance_uid) DO UPDATE`**.
Esto garantiza que:

- No se registren filas duplicadas en la base de datos.
- Si los metadatos han cambiado o es necesario refrescarlos, se sobrescriben de forma segura con la versión más reciente (`EXCLUDED`).
- Se actualiza la marca de tiempo de subida (`uploaded_at = NOW()`).

### Ingesta Forzada (`?force=true`)

Cuando el seeder o un cliente quiere sobrescribir deliberadamente los registros de metadatos, se puede invocar la API agregando el parámetro `?force=true`. Esto ejecutará una eliminación previa (`DELETE FROM studies WHERE sop_instance_uid = ...`) garantizando una inserción limpia sin violar restricciones de integridad.

---

## 2. Flujo Automatizado Moderno (Recomendado)

Si necesitas vaciar por completo el sistema y arrancar de cero con un set de datos limpio de prueba:

### Paso A: Limpiar y Apagar todo

Ejecuta el target de limpieza general para apagar los contenedores Docker, eliminar sus volúmenes asociados (Postgres y Orthanc) y remover toda la data física temporal en staging:

```bash
make clean
```

### Paso B: Generar Data Sintética Limpia

Genera 5 pacientes 2D estructurados en subcarpetas e inyecta un volumen 3D sintético de 64 cortes en `./data/staging/dicom/`:

```bash
make generate-fake-data
```

### Paso C: Levantar el Entorno y Sembrar (Seeding)

Levanta la infraestructura local:

```bash
make up
```

Una vez que el backend esté arriba, inyecta la data recién generada mediante el contenedor de seeding:

```bash
make seed
```

---

## 3. Flujo Manual Alternativo

Si deseas hacer un vaciado fino sin detener los contenedores de Docker ni eliminar los volúmenes, puedes hacerlo mediante queries y llamadas directas.

### Paso 1: Vaciar PostgreSQL manualmente

```bash
docker exec -it micd-postgres \
  psql -U micd -d micd -c "TRUNCATE TABLE studies RESTART IDENTITY;"
```

### Paso 2: Vaciar Orthanc manualmente

```bash
for id in $(curl -s -u orthanc:orthanc http://localhost:8042/studies | python3 -c "import sys,json; [print(x) for x in json.load(sys.stdin)]"); do
  curl -s -X DELETE -u orthanc:orthanc "http://localhost:8042/studies/$id"
  echo "Deleted study: $id"
done
```

### Paso 3: Cargar Archivos DICOM del Host

Si deseas subir archivos DICOM locales en bloque desde la consola del host:

```bash
for f in ./data/staging/dicom/**/*.dcm; do
  status=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST http://localhost:3000/api/v1/studies/upload \
    -F "file=@$f")
  echo "Status: $status | File: $(basename "$f")"
done
```

_Códigos HTTP esperados:_

- `201 Created` — subido e indexado correctamente.
- `409 Conflict` — duplicado detectado (ya existe en Postgres/Orthanc, no se modifica).
- `400 Bad Request` — el archivo carece de preámbulo DICOM válido.
