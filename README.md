# MICD Backend Service

Este repositorio contiene la API REST y la capa de persistencia del sistema **MICD** para la gestión e ingesta de estudios médicos en formato DICOM. 

Es un microservicio desarrollado con **TypeScript y Express** que coordina la persistencia de metadatos relacionales en **PostgreSQL** y el almacenamiento de las imágenes nativas en el PACS **Orthanc**.

---

## Propósito del Microservicio

* **Ingesta DICOM:** Procesa archivos subidos por el cliente, valida sus bytes mágicos y los envía al PACS Orthanc.
* **Persistencia Indexada:** Extrae los metadatos de las cabeceras DICOM (Nombre del paciente, ID, Modalidad, Fecha del estudio) y los indexa en PostgreSQL para soportar búsquedas ágiles con soporte trigram (GIN indexes).
* **Capa de Abstracción y Seguridad:** Actúa como proxy/puente seguro ante la API REST de Orthanc. Protege las credenciales de administración del PACS, evitando que estas se expongan al cliente web.
* **Servicio de Transmisión de Imágenes:** Envía y ordena las instancias de un estudio médico de forma que el visor frontend pueda renderizarlas secuencialmente.

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
├── docker-compose.yml          # Postgres + Orthanc + Backend API (Red Docker: micd)
├── Makefile                    # Comandos abreviados de desarrollo y operaciones
├── scripts/check.sh            # Script de verificación del estado del stack
├── docs/                       # Guías operativas y de testing de la base de datos
├── .data.example/              # Archivos DICOM de prueba para seeding
└── .env.example                # Variables de entorno pre-documentadas con valores default
```

---

## Instrucciones de Arranque y Despliegue

### Requisitos Previos
* **Docker y Docker Compose** instalados en el host.
* **Node.js** (v20 o superior) y **npm** (si deseas desarrollo local fuera de Docker).

### Paso 1: Inicialización
Crea tu archivo de entorno a partir de la plantilla y descarga las dependencias locales de desarrollo:
```bash
make install
```
*Esto ejecutará `npm install` y copiará `.env.example` como `.env`.*

### Paso 2: Levantar el Stack Docker
Levanta las bases de datos, el servidor PACS y la API del backend:
```bash
make up
```
*Este comando crea de forma automática la red Docker **`micd`**, que es requerida por el frontend para comunicarse con la API.*

### Paso 3: Verificar la Salud del Stack
Asegúrate de que todos los servicios estén sanos y respondiendo en sus respectivos puertos:
```bash
make check
```

---

## Comandos de Desarrollo y Testing

### Desarrollo Local (Fuera de Docker)
Si quieres correr el backend localmente con autorecarga (necesita que Postgres y Orthanc estén corriendo en Docker):
```bash
npm run dev
```

### Ejecutar Pruebas
* **Pruebas Unitarias:**
  ```bash
  npm test
  ```
* **Pruebas de Integración (Requiere stack levantado):**
  ```bash
  make test
  ```

---

## Control de Calidad (Git Hooks)

Este repositorio utiliza `pre-commit` para garantizar la adherencia a las normas de código limpio y formato consistente del proyecto.

Para activar los Git Hooks localmente, asegúrate de tener instalado `pre-commit` (`pip install pre-commit` o tu gestor de paquetes de preferencia) y ejecuta:
```bash
make hooks
```
Esto configurará los hooks para correr **Prettier**, **ESLint**, **CSpell** (corrección ortográfica en inglés) y las **pruebas de integración** de forma automática antes de confirmar o subir tus commits.
