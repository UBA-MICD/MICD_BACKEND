[![codecov](https://codecov.io/gh/UBA-MICD/MICD_BACKEND/graph/badge.svg?token=IE497ZSIRW)](https://codecov.io/gh/UBA-MICD/MICD_BACKEND)

# MICD Backend Service

Este repositorio contiene la API REST y la capa de persistencia del sistema **MICD** para la gestión e ingesta de estudios médicos en formato DICOM.

Es un microservicio desarrollado con **TypeScript y Express** que coordina la persistencia de metadatos relacionales en **PostgreSQL** y el almacenamiento de las imágenes nativas en el PACS **Orthanc**.

---

## Propósito del Microservicio

- **Ingesta DICOM:** Procesa archivos subidos por el cliente, valida sus bytes mágicos y los envía al PACS Orthanc.
- **Persistencia Indexada:** Extrae los metadatos de las cabeceras DICOM (Nombre del paciente, ID, Modalidad, Fecha del estudio) y los indexa en PostgreSQL para soportar búsquedas ágiles con soporte trigram (GIN indexes).
- **Capa de Abstracción y Seguridad:** Actúa como proxy/puente seguro ante la API REST de Orthanc. Protege las credenciales de administración del PACS, evitando que estas se expongan al cliente web.
- **Servicio de Transmisión de Imágenes:** Envía y ordena las instancias de un estudio médico de forma que el visor frontend pueda renderizarlas secuencialmente.

---

## Estructura del Proyecto

```text
MICD_BACKEND/
├── src/
│   ├── index.ts                # Servidor Express: Rutas, proxies y healthcheck
│   ├── db.ts                   # Inicialización de la base de datos y pool de conexión PG
│   ├── upload.ts               # Manejo de subidas DICOM y extracción de metadatos
│   ├── instances-util.ts       # Ordenamiento secuencial de imágenes de un estudio
│   └── *.test.ts               # Pruebas unitarias e integración (Jest)
├── Dockerfile                  # Construcción multi-stage (builder -> runtime slim)
├── docker-compose.yml          # Postgres + Orthanc + Backend API + Seeder service
├── docker-compose.prod.yml     # Stack de producción endurecido (ver "Despliegue en Producción")
├── Makefile                    # Comandos abreviados de desarrollo y operaciones
├── scripts/
│   ├── check.sh                # Script de verificación del estado del stack (local y docker)
│   ├── generate_synthetic_data.py   # Script de generación de pacientes 2D aleatorios
│   ├── generate_volumetric_data.py  # Script de generación de volumen 3D sintético (esfera)
│   └── seed_api.ts             # Script TypeScript para seeding automatizado
├── docs/                       # Guías operativas y de testing de la base de datos
├── .data.example/              # Archivos DICOM de prueba base para la generación
├── .env.example                # Variables de entorno pre-documentadas con valores default (desarrollo)
└── .env.prod.example           # Variables requeridas para docker-compose.prod.yml (sin defaults inseguros)
```

---

## Instrucciones de Arranque y Despliegue

### Requisitos Previos

- **Docker y Docker Compose** instalados en el host.
- **Node.js** (v20 o superior) y **npm** (si deseas desarrollo local fuera de Docker).
- **Python** (v3 y `uv` para compilar/generar datos falsos en local).

### Flujo de Arranque Estándar

Sigue este paso a paso para clonar, configurar e iniciar el entorno con datos listos para pruebas:

#### Paso 1: Instalación y Configuración del Entorno

Crea tu archivo de entorno a partir de la plantilla y pre-calienta las dependencias y la caché de Python de forma aislada (usando `uv`):

```bash
make install
```

_Esto ejecutará `npm install`, creará el archivo `.env` local desde `.env.example`, y descargará la caché efímera de Python._

#### Paso 2: Generar Datos de Prueba Sintéticos

Genera 5 pacientes 2D estructurados en subcarpetas e inyecta un estudio volumétrico 3D de 64 cortes en `./data/staging/dicom/`:

```bash
make generate-fake-data
```

#### Paso 3: Levantar el Stack Docker

Levanta las bases de datos, el servidor PACS y la API del backend:

```bash
make up
```

#### Paso 4: Poblar Base de Datos (Seeding)

Envía toda la data generada en staging hacia la API de forma automática mediante un contenedor docker efímero en TypeScript que espera a que el servidor de Express esté listo:

```bash
make seed
```

_Nota: Este comando es completamente idempotente. Si se ejecuta más de una vez, actualizará los metadatos y evitará duplicados tanto en Orthanc como en Postgres._

#### Paso 5: Verificar la Salud del Stack

Asegúrate de que todos los servicios y contenedores estén activos e inspecciona el volumen de estudios e instancias DICOM almacenadas en Orthanc:

```bash
make check
```

#### Documentación de la API (Swagger)

Con el stack levantado, la documentación interactiva de la API (Swagger UI) está disponible en:

- **Swagger UI:** [http://localhost:3000/api/docs](http://localhost:3000/api/docs)
- **Especificación OpenAPI (JSON):** [http://localhost:3000/api/docs/openapi.json](http://localhost:3000/api/docs/openapi.json)

La especificación vive en `src/openapi.ts` y debe actualizarse al agregar o modificar endpoints.

---

## Variables de Entorno

Tanto el script de testing como el proceso de seeding y health-check leen dinámicamente las variables de configuración de tu archivo `.env`.

- `BACKEND_PORT` (o `PORT`): Define el puerto expuesto del backend (default `3000`).
- `ORTHANC_HTTP_PORT`: Define el puerto REST de Orthanc (default `8042`).
- `ORTHANC_USERNAME` / `ORTHANC_PASSWORD`: Define el usuario y contraseña del PACS (default `orthanc`).
- `ANONYMIZATION_VERIFY_MODE`: `strict` (default) o `warn` — cómo reacciona la
  ingesta cuando una instancia conserva PHI (ver abajo). Un valor inválido
  **falla el arranque**, no cae a un default silencioso.

---

## Anonimización: qué verifica el backend (US-16)

El backend **no anonimiza**: los DICOM llegan ya anonimizados desde el cliente,
que los procesa en la máquina del usuario (ver el README de `MICD_WEB`). Lo que
sí hace es **verificar**, porque de este lado está la puerta de salida pública.

### Verificación en la ingesta

Al subir una instancia, el backend lee los tags que Orthanc devuelve y
comprueba que no quede valor identificatorio: nombres, direcciones, teléfonos e
institución vacíos o con placeholder; `PatientID`, `AccessionNumber` y `StudyID`
hasheados; fecha de nacimiento neutralizada; y el atestado PS3.15
`PatientIdentityRemoved = YES`.

Sólo si eso pasa se completa `studies.anonymized_at`. **Esa columna registra una
verificación, no una afirmación de quien sube.**

**Qué pasa si no pasa (TK-11), según `ANONYMIZATION_VERIFY_MODE`:**

| Modo               | Instancia con PHI residual                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `strict` (default) | Se **borra de Orthanc** y **no se guarda** nada; el usuario recibe un `422 not_anonymized` con la lista de tags problemáticos. |
| `warn`             | Se guarda, pero con `studies.needs_review = true` y `review_findings` (la lista PHI-free), y se avisa al usuario.              |

Si la verificación no puede leer los tags, **falla cerrado**: en `strict` bloquea
igual, en `warn` guarda marcado como no verificado. El `BurnedInAnnotation = YES`
o una modalidad de riesgo (US/SC/XA) agregan un _warning_ que marca el estudio
para revisión sin bloquear (los píxeles no se inspeccionan — ver Alcance).

> El código está en [`src/shared/phi-verification.ts`](src/shared/phi-verification.ts)
> (el verificador) y [`src/modules/upload/upload.service.ts`](src/modules/upload/upload.service.ts)
> (la decisión en la ingesta).

### Verificación antes de publicar en Zenodo

Publicar genera un **DOI público y permanente**, así que esa ruta no se fía de
la columna: vuelve a leer los tags desde Orthanc, instancia por instancia, y
rechaza si encuentra algo identificatorio. La verificación corre en todos los
caminos que pueden terminar publicando, incluido el reintento.

| Código                     | HTTP | Cuándo                                                       |
| -------------------------- | ---- | ------------------------------------------------------------ |
| `not_anonymized`           | 422  | Alguna instancia no tiene `anonymized_at`                    |
| `phi_detected`             | 422  | Los tags almacenados todavía tienen datos identificatorios   |
| `verification_unavailable` | 503  | No se pudieron leer los tags (Orthanc caído) — falla cerrado |

El mensaje de error nombra los tags y el motivo, **nunca los valores**, para no
reintroducir el dato que está reportando en logs ni en respuestas HTTP.

### Alcance y límites

- La verificación mira **sólo tags de primer nivel**. No recorre secuencias
  anidadas ni enumera tags privados, y no compara contra el original (que este
  lado no tiene): usa heurísticas sobre el valor almacenado. El perfil del
  anonimizador elimina esas secuencias, así que es un límite consciente, no un
  olvido.
- **No mira los píxeles.** El texto quemado en la imagen no se detecta por
  contenido — hallazgo H1. El backend sólo lo _señala_ vía `BurnedInAnnotation`
  o la modalidad (warning → `needs_review`); no hace OCR.
- No verifica **el algoritmo del otro equipo**: confía en que, si los tags
  quedaron limpios, el módulo hizo su trabajo. Esta capa es defensa en
  profundidad sobre esa salida, no un reemplazo.
- Con `curl` u otro cliente que no sea el visor, la misma puerta aplica: en
  `strict` la ingesta rechaza el PHI (cierra el hallazgo M1), en `warn` lo marca.

### Cómo correr las pruebas

```bash
npm run test:unit    # verificador + ingesta (strict/warn) + config del modo
make test            # unitarias + integración contra la pila levantada
```

Cubren: un DICOM bien anonimizado pasa; con PHI residual se rechaza (strict) o
se marca (warn); UIDs/fecha/tags privados; el verificador que falla cierra; y
que ninguna respuesta, log ni finding lleve **valores** de tags. La cobertura de
`phi-verification.ts` y `upload.service.ts` está gateada a ≥80% en
`jest.config.js`. La suite de extremo a extremo con DICOM con PHI falso vive en
`testing/anonymization/` — ver su README.

---

## Despliegue en Producción

`docker-compose.prod.yml` es un stack completo independiente (no un overlay sobre `docker-compose.yml`) pensado para un despliegue real: sin puertos publicados para Postgres/Orthanc, imágenes ancladas por digest, `cap_drop: ALL` + `read_only` en el backend, límites de CPU/memoria y rotación de logs. Usa los mismos nombres de contenedor y red que `docker-compose.yml`, así que **no corras ambos stacks a la vez** — este reemplaza al otro para producción.

```bash
cp .env.prod.example .env
# completar cada valor en blanco (ver comentarios del archivo para el comando de generación)
docker compose -f docker-compose.prod.yml up -d --build
```

Puntos clave:

- **Sin secretos por default:** `DB_PASSWORD`, `ORTHANC_PASSWORD`, `JWT_SECRET`, `JWT_REFRESH_SECRET` y `ADMIN_PASSWORD` son obligatorios — tanto Compose (`${VAR:?...}`) como `env.ts` fallan al arrancar si quedan vacíos o en su valor de desarrollo.
- **HTTPS opcional en el propio backend:** con `TLS_ENABLED=true` (y `TLS_CERT_PATH`/`TLS_KEY_PATH`/`TLS_CERTS_DIR` configurados), Express sirve HTTPS directamente — sin depender de un proxy reverso delante. Por default queda en HTTP plano.
- **Liveness vs readiness:** `GET /api/livez` (sin dependencias, señal de reinicio) y `GET /api/readyz` (Postgres + Orthanc alcanzables, señal de "listo para tráfico") — `GET /api/health` se mantiene como alias de `/api/readyz` por compatibilidad.
- **Recursos y logs configurables** vía `POSTGRES_CPU_LIMIT`/`POSTGRES_MEM_LIMIT`, `ORTHANC_CPU_LIMIT`/`ORTHANC_MEM_LIMIT`, `BACKEND_CPU_LIMIT`/`BACKEND_MEM_LIMIT`, `LOG_MAX_SIZE`/`LOG_MAX_FILES` — ver `.env.prod.example`.
- **Roles y gestión de usuarios (US-21 / US-H04):** `ADMIN_EMAIL`/`ADMIN_PASSWORD` siembran el primer admin en la migración 006 (solo si ambos están seteados; el hash se genera en la base). El flujo de invitación usa `APP_BASE_URL` para armar el link y `SMTP_*` para enviar el correo — con `SMTP_HOST` vacío el link se escribe en el log en vez de enviarse (útil en dev/CI). Ver [`docs/rbac.md`](./docs/rbac.md) y [`docs/user-management.md`](./docs/user-management.md).

---

## Comandos de Desarrollo y Testing

### Desarrollo Local (Fuera de Docker)

Si quieres correr el backend localmente con autorecarga (requiere que Postgres y Orthanc estén corriendo en Docker):

```bash
npm run dev
```

### Ejecutar Pruebas

- **Pruebas Unitarias & Integración en Node.js (Express & DB):**
  ```bash
  make test
  ```
- **Pruebas Unitarias de Scripts de Python (Datos Sintéticos):**
  ```bash
  make test-python
  ```

### Limpieza de Datos y Cachés

Si necesitas reiniciar el entorno local, puedes remover selectivamente los archivos o limpiar todo:

- **Limpiar datos en staging:** `make clean-data`
- **Limpiar cachés de Python (`__pycache__`, `.pyc`, cache de `uv`):** `make clean-python`
- **Limpieza general:** `make clean` (detiene contenedores, elimina volúmenes y borra staging y cachés de Python).

---

## Control de Calidad (Git Hooks)

Para activar los Git Hooks localmente, asegúrate de tener instalado `pre-commit` y ejecuta:

```bash
make hooks
```

Esto ejecutará automáticamente **Prettier**, **ESLint** y las **pruebas de integración** antes de confirmar o subir tus commits.

## Seguimiento de Cobertura

Mantenemos un control estricto de la calidad del código. A continuación, puedes revisar el gráfico de cobertura actual generado por Codecov:

[![Gráfico circular de cobertura de Codecov](https://codecov.io/gh/UBA-MICD/MICD_BACKEND/graphs/sunburst.svg?token=IE497ZSIRW)](https://codecov.io/gh/UBA-MICD/MICD_BACKEND)

> **Nota:** Haz clic en el gráfico para ver el reporte detallado línea por línea en el panel de Codecov.
