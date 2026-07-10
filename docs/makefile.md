# Makefile — Guía de comandos

## Referencia rápida

| Comando                   | Descripción                                                                              |
| :------------------------ | :--------------------------------------------------------------------------------------- |
| `make install`            | Instala dependencias locales de Node.js y pre-calienta el caché de dependencias Python.  |
| `make up`                 | Levanta el stack principal (postgres + orthanc + backend) en segundo plano.              |
| `make seed`               | Inicia el contenedor efímero TypeScript para inyectar la data DICOM de staging.          |
| `make generate-fake-data` | Genera 5 pacientes 2D aleatorios y 1 volumen 3D sintético en `./data/staging/dicom/`.    |
| `make test-python`        | Ejecuta las pruebas unitarias del generador y anonimizador en Python.                    |
| `make down`               | Detiene y elimina los contenedores locales.                                              |
| `make build`              | Reconstruye todas las imágenes Docker de la aplicación.                                  |
| `make restart`            | Recompila el backend y reinicia todo el stack Docker.                                    |
| `make check`              | Verifica la salud de los contenedores, la API REST y el conteo de estudios/instancias.   |
| `make test`               | Corre las pruebas de integración en Express contra el PACS.                              |
| `make logs`               | Sigue los logs en tiempo real de todos los contenedores.                                 |
| `make ps`                 | Muestra el estado actual y los puertos de los contenedores.                              |
| `make clean-data`         | Elimina la carpeta `./data` de datos temporales de staging.                              |
| `make clean-python`       | Borra directorios `__pycache__`, archivos `.pyc` y vacía la caché de `uv`.               |
| `make clean`              | Ejecuta `clean-data` + `clean-python` y destruye los contenedores y volúmenes de Docker. |

---

## Flujo de Arranque para Nuevos Desarrolladores

Para clonar e iniciar el entorno listo para pruebas locales:

```bash
make install             # 1. Configura el .env y cachea dependencias
make generate-fake-data  # 2. Genera los archivos DICOM sintéticos
make up                  # 3. Levanta Postgres, Orthanc y la API
make seed                # 4. Inyecta los archivos DICOM de staging a la API
make check               # 5. Verifica salud y conteo de datos cargados
```

---

## Flujo de Desarrollo

### Cambios en el código fuente

Si modificas archivos TypeScript en `src/`, debes reconstruir el contenedor del backend para que refleje los cambios compilados:

```bash
make build     # reconstruye la imagen del backend
make up        # reinicia el contenedor con la nueva imagen
make check     # verifica que todo siga corriendo bien
```

### Ver logs de un servicio específico

```bash
make logs

# O de forma individual
docker compose logs -f backend
docker compose logs -f orthanc
```

---

## make check — detalle

Ejecuta el script `scripts/check.sh` y reporta:

1. **Containers:** Estado y salud de `micd-postgres`, `micd-orthanc` y `micd-backend`.
2. **Backend:** Prueba de respuesta de `GET /api/health` (conectividad con Orthanc) y `GET /api/studies` (conteo de estudios relacionales).
3. **Orthanc:** Intento de acceso sin credenciales (401 expected) y conexión autenticada para reportar la cantidad exacta de instancias DICOM cargadas.

Ejemplo de salida exitosa:

```
▶ Checking MICD backend stack...

▶ Containers
  ✔ micd-postgres (running / healthy)
  ✔ micd-orthanc (running / healthy)
  ✔ micd-backend (running / healthy)

▶ Backend
  ✔ GET /api/health → ok (Orthanc 1.12.2)
  ✔ GET /api/studies → 6 study/studies in Orthanc

▶ Orthanc
  ✔ Unauthenticated request → 401 Unauthorized
  ✔ Orthanc connection → 99 DICOM instance(s) stored

All checks passed.
```

---

## make test — tests de integración

Requiere que el stack esté corriendo. Corre la suite de pruebas Jest:

```bash
make up     # si no está corriendo
make test
```

Los tests cubren la ingesta, detección de duplicados, proxies, thumbnails de estudios y descarga de instancias individuales.

---

## make clean — limpieza completa

```bash
make clean
```

Detiene los servicios, elimina los contenedores y destruye de forma irreversible los volúmenes nombrados de PostgreSQL y Orthanc. Además, limpia todos los archivos temporales generados en `./data` y las cachés de Python.

> **Advertencia:** Los estudios cargados en el PACS y la información guardada en Postgres se eliminarán por completo.
