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
├── Makefile                    # Comandos abreviados de desarrollo y operaciones
├── scripts/
│   ├── check.sh                # Script de verificación del estado del stack (local y docker)
│   ├── generate_synthetic_data.py   # Script de generación de pacientes 2D aleatorios
│   ├── generate_volumetric_data.py  # Script de generación de volumen 3D sintético (esfera)
│   └── seed_api.ts             # Script TypeScript para seeding automatizado
├── docs/                       # Guías operativas y de testing de la base de datos
├── .data.example/              # Archivos DICOM de prueba base para la generación
└── .env.example                # Variables de entorno pre-documentadas con valores default
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

---

## Variables de Entorno

Tanto el script de testing como el proceso de seeding y health-check leen dinámicamente las variables de configuración de tu archivo `.env`.

- `BACKEND_PORT` (o `PORT`): Define el puerto expuesto del backend (default `3000`).
- `ORTHANC_HTTP_PORT`: Define el puerto REST de Orthanc (default `8042`).
- `ORTHANC_USERNAME` / `ORTHANC_PASSWORD`: Define el usuario y contraseña del PACS (default `orthanc`).

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

Esto ejecutará automáticamente **Prettier**, **ESLint**, **CSpell** y las **pruebas de integración** antes de confirmar o subir tus commits.
