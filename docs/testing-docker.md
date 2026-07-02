# Testing — Docker Stack

Guía para verificar que el stack del backend funciona correctamente.

## Prerequisitos

- Docker >= 24 y Docker Compose >= 2.20 instalados
- Puertos libres: 3000, 5432, 8042, 4242
- Archivos `.dcm` de prueba disponibles en `.data.example/`

---

## 1. Setup inicial

```bash
# Clonar el repo y pararse en la carpeta
cd MICD_BACKEND

# Copiar variables de entorno (solo la primera vez)
cp .env.example .env

# Construir imágenes y levantar todos los servicios
docker compose up --build
```

Esperar hasta ver en los logs:
```
micd-backend   | MICD backend listening on port 3000
micd-orthanc   | Orthanc has started
micd-postgres  | database system is ready to accept connections
```

---

## 2. Verificar que todos los contenedores están corriendo

```bash
docker compose ps
```

Resultado esperado — todos en estado `running`:

```
NAME             IMAGE                    STATUS
micd-postgres    postgres:16-alpine       running (healthy)
micd-orthanc     orthancteam/orthanc      running (healthy)
micd-backend     micd_backend-backend     running (healthy)
```

---

## 3. Health check del backend

```bash
curl http://localhost:3000/api/health
```

Respuesta esperada:
```json
{ "status": "ok", "orthanc": "1.12.x" }
```

Si Orthanc no está listo aún puede devolver `"status": "degraded"` — esperar 10 segundos y reintentar.

---

## 4. Interfaz web de Orthanc

Abrir en el browser:
```
http://localhost:8042
```

- Usuario: `orthanc`
- Contraseña: `orthanc`

Verificar que la interfaz de Orthanc Explorer 2 carga correctamente.

---

## 5. Subir un estudio DICOM y verificar el flujo completo

### 5a. Subir via curl

```bash
# Subir todas las instancias de la serie de ejemplo
for f in .data.example/series-000001/*.dcm; do
  curl -s -u orthanc:orthanc \
       -X POST http://localhost:8042/instances \
       --data-binary @"$f" | jq .
done
```

Respuesta esperada por cada archivo:
```json
{
  "ID": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "ParentPatient": "...",
  "ParentSeries": "...",
  "ParentStudy": "...",
  "Path": "/instances/...",
  "Status": "Success"
}
```

### 5b. Verificar que el backend expone los estudios

```bash
curl http://localhost:3000/api/studies
```

Debe devolver un array con el ID del estudio recién subido:
```json
["xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"]
```

### 5c. Ver detalle de un estudio

```bash
STUDY_ID=$(curl -s http://localhost:3000/api/studies | jq -r '.[0]')
curl http://localhost:3000/api/studies/$STUDY_ID | jq .
```

---

## 6. Frontend (repo MICD_WEB)

El frontend vive en el repo [MICD_WEB](https://github.com/UBA-MICD/MICD_WEB) y se
conecta a este stack a través de la red Docker compartida `micd` (este compose la
crea; el compose del frontend la declara `external`). Para probar el flujo completo:

```bash
# Con este stack ya levantado
cd ../MICD_WEB
docker compose up -d --build
curl http://localhost/api/health   # proxy nginx → backend:3000
```

---

## 7. Persistencia de datos entre reinicios

```bash
# Detener el stack (sin borrar volúmenes)
docker compose down

# Volver a levantar
docker compose up

# Verificar que el estudio subido en el paso 5 sigue presente
curl http://localhost:3000/api/studies
```

Debe devolver el mismo array con el estudio — confirma que los volúmenes `orthanc-data` y `postgres-data` persisten.

---

## 8. Test de conflicto de puertos

Si algún puerto ya está ocupado en la máquina local:

```bash
# Editar .env con puertos alternativos
DB_PORT=5433
ORTHANC_HTTP_PORT=8043
BACKEND_PORT=3001

# Reiniciar
docker compose down
docker compose up
```

Verificar que el stack levanta con los nuevos puertos:
```bash
curl http://localhost:3001/api/health
curl http://localhost:8043/system -u orthanc:orthanc
```

---

## 9. Test de rebuild limpio (< 3 minutos)

```bash
# Borrar imágenes y volver a buildear desde cero
docker compose down --rmi local
time docker compose up --build
```

El tiempo total de build + startup debe ser menor a 3 minutos.

---

## Criterios de aceptación cubiertos

| Criterio | Cómo verificarlo |
|----------|-----------------|
| `docker compose up --build` levanta todo sin errores | Sección 1 y 2 |
| Todos los servicios levantan en < 3 min | Sección 9 |
| Datos persisten entre reinicios | Sección 7 |
| Nuevo dev: `cp .env.example .env && docker compose up` funciona | Sección 1 (sin pasos adicionales) |
| Puerto 5432 ya ocupado → parametrizar en .env | Sección 8 |
