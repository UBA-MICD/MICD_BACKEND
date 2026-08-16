# Docker — MICD Backend Stack

Guía completa para levantar el stack del backend con Docker Compose.

> **Nota:** el proyecto original ([MICD_APP](https://github.com/UBA-MICD/MICD_APP)) se separó en dos repos:
> **MICD_BACKEND** (este repo: API + PostgreSQL + Orthanc) y [**MICD_WEB**](https://github.com/UBA-MICD/MICD_WEB)
> (SPA servida por Nginx). Ambos stacks se comunican por la red Docker compartida `micd`,
> que crea este compose.

## Decisiones de arquitectura y justificación tecnológica

### Por qué migrar de Electron a un stack web

La app original usa Electron para leer archivos `.dcm` directamente del disco local. Ese modelo tiene tres limitaciones estructurales:

1. **Un solo usuario, una sola máquina** — otro médico en otra PC no puede acceder a los estudios.
2. **Sin persistencia centralizada** — los archivos viven en el filesystem de cada desarrollador o usuario.
3. **No deployable en servidor** — Electron necesita una pantalla (X11/GUI); no puede correr en un servidor FIUBA headless.

Un stack web (SPA + API REST + PACS + DB) resuelve los tres problemas y es el modelo estándar en sistemas de información médica hospitalaria.

---

### Orthanc — servidor DICOM

**¿Qué es?** Orthanc es un servidor PACS (_Picture Archiving and Communication System_) open-source, liviano y con API REST nativa.

**¿Por qué Orthanc y no otra cosa?**

| Alternativa | Problema                                                                                                                                                             |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Filesystem  | No escala, no es multi-usuario, sin protocolo DICOM estándar                                                                                                         |
| `dcm4chee`  | Muy pesado (Java EE), configuración compleja, over-engineering para el alcance del proyecto                                                                          |
| OHIF Viewer | Es un _viewer_, no un servidor PACS; no resuelve el almacenamiento                                                                                                   |
| Orthanc ✓   | Liviano (C++), imagen Docker oficial, API REST out-of-the-box, soporta protocolo DICOM nativo, ampliamente usado en proyectos académicos y hospitalarios open-source |

**¿Qué aporta al stack?**

- Centraliza el almacenamiento de estudios DICOM en el servidor
- Expone una API REST que el backend consulta para listar, buscar y recuperar estudios
- Soporta C-STORE y C-FIND: equipos médicos reales (tomógrafos, resonadores) pueden "empujar" estudios directamente

**Origen de la decisión — propuesta UBA-MICD (sección 4.4)**

Orthanc figura explícitamente en las tecnologías preliminares del Trabajo Profesional:

> _"Procesamiento DICOM: Orthanc / pydicom"_

No fue una elección arbitraria de implementación: es la tecnología acordada con los directores (Dr. Ing. Sergio E. Lew e Ing. Alejandro Molinari) y alineada con el objetivo de integrar la plataforma con el PACS existente del Hospital de Clínicas.

**Orthanc vs pydicom — cuándo usar cada uno**

| Herramienta | Cuándo usarla                                                                                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Orthanc** | Almacenamiento, búsqueda y recuperación de estudios vía API REST o protocolo DICOM (C-STORE, C-FIND). Es el servidor central que recibe estudios desde el Hospital.                                                                        |
| **pydicom** | Procesamiento Python de archivos `.dcm` individuales: leer/modificar tags, anonimizar metadatos, validar conformidad DICOM antes de enviar a Orthanc. Se usaría en un worker de procesamiento o script de anonimización, no como servidor. |

En la arquitectura actual, Orthanc cubre el rol de servidor PACS. pydicom entraría si se implementa el módulo de **anonimización automática** (sección 4.1 del Trabajo Profesional: "Procesamiento automático de imágenes DICOM para eliminar información de identificación personal previo a cualquier transmisión") — ese procesamiento ocurriría en el backend antes de hacer C-STORE a Orthanc.

---

### PostgreSQL — base de datos relacional

Almacena metadata de estudios, usuarios, resultados de análisis y cualquier dato estructurado de la aplicación. Se eligió sobre SQLite (no es multi-usuario ni apto para servidor) y sobre MongoDB (los datos son relacionales por naturaleza).

---

### Nginx — servidor web del frontend (repo MICD_WEB)

El frontend vive en [MICD_WEB](https://github.com/UBA-MICD/MICD_WEB): Nginx sirve los estáticos compilados y actúa como reverse proxy hacia este backend (`/api/*`). Esto evita problemas de CORS en producción y permite agregar TLS/HTTPS en un solo punto en el futuro.

---

### Node.js + Express — backend API

TypeScript ya era el lenguaje del proyecto, por lo que mantener Node.js en el backend elimina el cambio de contexto de lenguaje para el equipo. Express es la opción más directa para una API REST sin overhead adicional.

---

## Servicios

| Servicio   | Imagen base             | Puerto por defecto        | Descripción                 |
| ---------- | ----------------------- | ------------------------- | --------------------------- |
| `postgres` | `postgres:16-alpine`    | 5432                      | Base de datos relacional    |
| `orthanc`  | `orthancteam/orthanc`   | 8042 (HTTP), 4242 (DICOM) | Servidor DICOM PACS         |
| `backend`  | `node:20-alpine` (slim) | 3000                      | API REST Express/TypeScript |

El servicio `frontend` (Nginx :80) se levanta desde el repo [MICD_WEB](https://github.com/UBA-MICD/MICD_WEB) y se une a la red `micd` de este stack.

## Estructura de archivos

```
MICD_BACKEND/
├── docker-compose.yml          # Orquestación: postgres + orthanc + backend
├── .env.example                # Variables de entorno documentadas
├── .dockerignore               # Exclusiones para el contexto de build
├── Dockerfile                  # Multi-stage: builder (tsc) → runtime (alpine slim)
├── Makefile                    # Comandos de desarrollo (ver docs/makefile.md)
├── package.json
├── tsconfig.json
├── scripts/
│   └── check.sh                # Verificación del stack (make check)
├── docs/                       # Documentación
├── .data.example/              # Series DICOM de ejemplo para testing
└── src/
    └── index.ts                # Express + healthcheck + proxy Orthanc
```

## Inicio rápido

```bash
# 1. Copiar variables de entorno
cp .env.example .env

# 2. Construir imágenes y levantar todos los servicios
docker compose up --build
```

La primera vez tarda ~2–3 minutos mientras se construyen las imágenes.
Las siguientes veces, sin cambios en código, levanta en segundos.

## Variables de entorno

Todas las variables tienen valores por defecto funcionales para desarrollo local.
Editar `.env` antes de correr en producción.

| Variable             | Default   | Descripción                                            |
| -------------------- | --------- | ------------------------------------------------------ |
| `DB_NAME`            | `micd`    | Nombre de la base de datos PostgreSQL                  |
| `DB_USER`            | `micd`    | Usuario de PostgreSQL                                  |
| `DB_PASSWORD`        | `micd`    | Contraseña de PostgreSQL                               |
| `DB_PORT`            | `5432`    | Puerto del host mapeado al contenedor de Postgres      |
| `ORTHANC_USERNAME`   | `orthanc` | Usuario para la API REST de Orthanc                    |
| `ORTHANC_PASSWORD`   | `orthanc` | Contraseña para la API REST de Orthanc                 |
| `ORTHANC_HTTP_PORT`  | `8042`    | Puerto del host para la interfaz web y REST de Orthanc |
| `ORTHANC_DICOM_PORT` | `4242`    | Puerto del host para DICOM C-STORE / C-FIND            |
| `BACKEND_PORT`       | `3000`    | Puerto del host expuesto por el backend Node.js        |

### Conflicto de puertos

Si un puerto ya está en uso en la máquina local, cambiar el valor en `.env`:

```env
# Ejemplo: PostgreSQL ocupado en 5432
DB_PORT=5433

# Ejemplo: backend ocupado en 3000
BACKEND_PORT=3001
```

## Persistencia de datos

Los datos sobreviven a reinicios y a `docker compose down` gracias a volúmenes nombrados:

| Volumen         | Contenido                             |
| --------------- | ------------------------------------- |
| `postgres-data` | Datos de PostgreSQL                   |
| `orthanc-data`  | Estudios DICOM almacenados en Orthanc |

Para **eliminar** los datos (reset completo):

```bash
docker compose down -v
```

## Comandos útiles

```bash
# Levantar en background
docker compose up -d --build

# Ver logs de un servicio específico
docker compose logs -f backend
docker compose logs -f orthanc

# Reiniciar un servicio (datos persisten)
docker compose restart backend

# Detener sin borrar datos
docker compose down

# Detener y borrar volúmenes (reset total)
docker compose down -v

# Ejecutar una shell dentro del backend
docker compose exec backend sh

# Conectarse a PostgreSQL desde la máquina local
psql -h localhost -p 5432 -U micd -d micd
```

## Endpoints disponibles tras levantar

| URL                                 | Descripción                                      |
| ----------------------------------- | ------------------------------------------------ |
| `http://localhost:3000/api/health`  | Healthcheck del backend (estado de DB y Orthanc) |
| `http://localhost:3000/api/studies` | Lista de estudios DICOM vía Orthanc              |
| `http://localhost:8042`             | Interfaz web de Orthanc                          |
| `http://localhost`                  | SPA (si el stack de MICD_WEB está levantado)     |

## Arquitectura de red

```
Browser
  │
  ▼
frontend (Nginx :80, repo MICD_WEB)
  ├── /            → serve /usr/share/nginx/html (SPA)
  └── /api/*       → proxy → backend:3000
                              │
                              ├── postgres:5432
                              └── orthanc:8042
```

Todos los servicios comparten la red Docker `micd` (creada por este compose;
el compose de MICD_WEB la declara `external`) y se comunican por nombre de
servicio (`postgres`, `orthanc`, `backend`). Solo los puertos listados en
`docker-compose.yml` quedan expuestos al host.

> **Orden de arranque:** este stack debe levantarse **antes** que el de MICD_WEB,
> porque es el que crea la red `micd`.

## Cómo se comunica el frontend con Orthanc

El frontend **nunca habla directamente con Orthanc**. Cada request recorre dos saltos:

```
SPA (browser)
  │  fetch('/api/studies')        ← misma origin, puerto 80
  ▼
Nginx (contenedor frontend :80, repo MICD_WEB)
  │  proxy_pass http://backend:3000
  ▼
Express (contenedor backend :3000)
  │  axios.get('http://orthanc:8042/studies', { auth: { ... } })
  ▼
Orthanc (:8042)
```

**Por qué esta indirección:**

- **Las credenciales nunca salen de la red Docker.** Orthanc requiere Basic Auth. Si el frontend llamara a `localhost:8042` directamente, el usuario/contraseña de Orthanc quedaría visible en el JS del browser.
- **Sin CORS.** Orthanc no está configurado para aceptar requests cross-origin. El backend llama a Orthanc desde adentro de la red interna de Docker.
- **Un solo origen para el browser.** Todo pasa por el puerto 80. Agregar TLS en el futuro implica tocarlo solo en Nginx.

**Lo que el frontend llama y a qué Orthanc corresponde:**

| Call del frontend      | El backend proxea a Orthanc                                 |
| ---------------------- | ----------------------------------------------------------- |
| `GET /api/studies`     | `GET http://orthanc:8042/studies`                           |
| `GET /api/studies/:id` | `GET http://orthanc:8042/studies/:id`                       |
| `GET /api/health`      | `GET http://orthanc:8042/system` (+ `SELECT 1` en Postgres) |

El puerto `8042` de Orthanc queda expuesto al host solo para uso en desarrollo (web UI, curl). La SPA nunca lo usa.

## Apple Silicon (M1/M2)

La imagen de Orthanc no tiene build nativo para `arm64`, por eso el servicio
tiene `platform: linux/amd64` en `docker-compose.yml`. Docker Desktop emula
la arquitectura automáticamente vía Rosetta 2 / QEMU.

## Builds multi-stage

El `Dockerfile` usa un build multi-stage para minimizar el tamaño de la imagen final:

1. `builder` — instala todas las dependencias y compila TypeScript con `tsc`
2. `runtime` — parte de `node:20-alpine` limpio, instala solo dependencias de producción, copia `dist/`

El Dockerfile del frontend (builder `tsc` → runtime Nginx) vive en [MICD_WEB](https://github.com/UBA-MICD/MICD_WEB).
