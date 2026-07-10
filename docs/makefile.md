# Makefile — Guía de comandos

## Referencia rápida

| Comando        | Descripción                                                      |
| -------------- | ---------------------------------------------------------------- |
| `make install` | Instala dependencias y crea `.env`                               |
| `make up`      | Levanta el stack (postgres + orthanc + backend) en segundo plano |
| `make down`    | Detiene y elimina los contenedores                               |
| `make build`   | Reconstruye todas las imágenes Docker                            |
| `make restart` | `build` + `up` en un solo paso                                   |
| `make check`   | Verifica que todos los servicios estén funcionando               |
| `make test`    | Corre los tests de integración                                   |
| `make logs`    | Sigue los logs de todos los servicios                            |
| `make ps`      | Muestra el estado de los contenedores                            |
| `make clean`   | Elimina contenedores, volúmenes e imágenes locales               |

---

## Primera vez

```bash
make install   # instala dependencias y crea .env
make up        # levanta el stack
make check     # verifica que todo esté ok
```

---

## Flujo de desarrollo

### Cambios en el backend

```bash
make build     # reconstruye la imagen del backend
make up        # reinicia el contenedor con la nueva imagen
make check     # verifica
```

### Solo ver qué está corriendo

```bash
make ps
```

### Ver logs en tiempo real

```bash
make logs

# Solo de un servicio
docker compose logs -f backend
docker compose logs -f orthanc
```

---

## make check — detalle

Ejecuta `scripts/check.sh` y verifica:

1. **Containers** — que `micd-postgres`, `micd-orthanc` y `micd-backend` estén `running` y `healthy`
2. **Backend** — `GET /api/health` retorna `{"status":"ok"}` con versión de Orthanc; `GET /api/studies` retorna JSON válido
3. **Orthanc** — acceso sin credenciales retorna `401 Unauthorized`

Ejemplo de salida exitosa:

```
▶ Checking MICD backend stack...

▶ Containers
  ✔ micd-postgres (running / healthy)
  ✔ micd-orthanc (running / healthy)
  ✔ micd-backend (running / healthy)

▶ Backend
  ✔ GET /api/health → ok (Orthanc 1.12.2)
  ✔ GET /api/studies → 0 study/studies in Orthanc

▶ Orthanc
  ✔ Unauthenticated request → 401 Unauthorized

All checks passed.
```

Si algo falla, el script termina con `exit 1` y marca el check fallido con `✘`.

> El frontend vive en el repo [MICD_WEB](https://github.com/UBA-MICD/MICD_WEB) y tiene su propio `make check` equivalente.

---

## make test — tests de integración

Requiere que Orthanc esté levantado. Corre la suite Jest contra `http://localhost:8042`.

```bash
make up     # si no está corriendo
make test
```

Los tests cubren: autenticación 401, upload de DICOM, recuperación de estudio con metadatos, y eliminación.

---

## make clean — limpieza completa

```bash
make clean
```

Elimina contenedores, **volúmenes** (se pierden los datos de Orthanc y PostgreSQL) e imágenes locales. Útil para empezar desde cero.

> **Advertencia:** los estudios DICOM almacenados en Orthanc se pierden al eliminar el volumen `orthanc-data`.
