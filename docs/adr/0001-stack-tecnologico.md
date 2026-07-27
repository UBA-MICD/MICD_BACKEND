# ADR-0001 — Stack tecnológico

- **Estado:** Aceptada
- **Fecha:** 2026-07-26
- **Decisores:** Equipo MICD
- **Alcance:** ambos repos
- **Relacionado:** US-01, ADR-0002, ADR-0003

## Contexto

MICD es un sistema de gestión y visualización de estudios médicos DICOM
desarrollado como Trabajo Profesional: equipo chico, sprints cortos, y un
entorno de evaluación donde el sistema tiene que levantar en la máquina de
cualquier integrante o del director sin infraestructura cloud.

Restricciones que condicionan el stack:

- Hay que **visualizar DICOM en el navegador** (window/level, zoom, pan,
  navegación de serie) y también **abrir archivos locales sin sesión**.
- Hay que **almacenar los píxeles** de forma conforme a DICOM y **buscar por
  metadatos** (paciente, modalidad, fecha) con respuestas ágiles.
- El despliegue tiene que ser **reproducible con un comando** y evaluable por
  terceros: Docker + Compose, un repo por componente.
- El equipo ya sabe TypeScript; no hay tiempo para aprender un ecosistema nuevo
  ni para operar un stack políglota.

## Opciones consideradas

### Opción A — TypeScript end-to-end + Orthanc + PostgreSQL (elegida)

- **Cómo sería:** Node.js/Express en el backend, TypeScript sin framework en el
  cliente, Orthanc como PACS, PostgreSQL como índice de metadatos.
- **A favor:** un solo lenguaje y un solo modelo de tipos en los dos repos;
  Orthanc resuelve el almacenamiento DICOM sin escribirlo; imágenes Docker
  chicas; el parseo DICOM en el navegador existe (`dicom-parser`).
- **En contra:** el ecosistema DICOM maduro es Python/Java, no Node: cualquier
  procesamiento de imagen serio (anonimización, validación de conformidad) hay
  que delegarlo fuera del backend (ver ADR-0005).

### Opción B — Python/FastAPI + pydicom

- **Cómo sería:** backend en Python, `pydicom` para leer y modificar tags.
- **A favor:** la mejor biblioteca DICOM del mercado en proceso; útil para
  anonimización y validación.
- **En contra:** dos lenguajes en el proyecto (el cliente igual es TypeScript),
  duplicación de tipos y de tooling de CI, y el equipo rinde menos por sprint.

### Opción C — Java + Spring Boot + dcm4chee

- **Cómo sería:** PACS y backend en el stack clínico "de industria".
- **En contra:** dcm4chee pide bastante más operación (JBoss/WildFly, LDAP,
  configuración por AE title) y consumo de memoria; desproporcionado para el
  alcance y hostil de levantar en una máquina de escritorio.

### Opción D — Frontend con framework (React + Vite + Cornerstone.js)

- **Cómo sería:** SPA con framework, bundler y visor DICOM de terceros.
- **A favor:** Cornerstone da herramientas de visor de entrada; DX moderna.
- **En contra:** agrega bundler, cadena de build y dependencias que hay que
  auditar y mantener; para un visor de una sola pantalla el framework aporta
  poco frente al costo de configuración y de tamaño de bundle.

## Decisión

Se adopta **TypeScript en los dos extremos, con Orthanc y PostgreSQL detrás del
backend**, priorizando un único lenguaje y la menor cantidad de piezas
operables:

- **Backend** (`MICD_BACKEND`): Node.js 20 + **Express 4** + TypeScript 5,
  compilado con `tsc` a `dist/`. Capas fijas
  `routes → controller → service → repository/client`.
- **Persistencia relacional**: **PostgreSQL 16**, con índices GIN trigram
  (`pg_trgm`) para la búsqueda por nombre de paciente. Migraciones propias
  idempotentes (`src/db/migrate.ts` + `db/migrations/*.ts`), sin herramienta de
  migración externa.
- **PACS**: **Orthanc 24.1.2** (`orthancteam/orthanc`) como almacén DICOM
  nativo — detalle en ADR-0003.
- **Cliente web** (`MICD_WEB`): TypeScript **sin framework y sin bundler**;
  `tsc` compila `src/**/*.ts` a módulos ES en `dist/` espejando carpetas, y
  `src/index.html` los carga con `<script type="module">`. `dicom-parser` (UMD)
  para el parseo en el navegador y `<canvas>` para el render.
- **Servidor web**: **nginx** sirve el estático y proxea `/api/*` y `/auth/*`
  (ADR-0002).
- **Tests**: **Jest + ts-jest** en el backend (unitarios e integración contra el
  stack real); **`node:test` con `--experimental-strip-types`** en el web (por
  eso el web necesita Node 22+ para testear, aunque el Dockerfile compile con
  Node 20). Cobertura reportada a Codecov en los dos repos.
- **Calidad**: `pre-commit` con Prettier + ESLint + CSpell en ambos repos; CI en
  GitHub Actions.
- **Despliegue**: un `docker-compose.yml` por repo, unidos por la red Docker
  compartida `micd`; el stack del backend la crea y el del web se une como
  externa (por eso el backend arranca primero).
- **Python** queda **fuera del runtime**: se usa sólo para scripts de datos
  sintéticos (`scripts/generate_*_data.py`, ejecutados con `uv`).

## Consecuencias

### Positivas

- Un lenguaje, un formateador, un linter y un patrón de tipos para todo el
  producto; un integrante puede moverse entre repos sin cambiar de contexto.
- Sin bundler no hay configuración de build que se rompa ni `node_modules` de
  cientos de paquetes en el cliente: la única dependencia de runtime del web es
  `dicom-parser`.
- Imágenes Docker multi-stage chicas y CI rápida (compilar es `tsc`).
- Orthanc y PostgreSQL cubren dos problemas grandes (almacenamiento conforme y
  búsqueda indexada) que el equipo no tiene que implementar.

### Negativas / costos asumidos

- **Sin bundler no hay hot reload ni tree-shaking en el web**: se itera con
  `npm run build` + recarga, y toda dependencia de navegador tiene que llegar
  como archivo UMD/ESM copiado al `dist` (`dicomParser.min.js` se carga por
  `<script>` antes de `main.js`).
- **Sin framework hay que escribir las primitivas de UI**: pantallas, diálogos
  con trampa de foco, grupos con roving tabindex y regiones live viven en
  `src/shared/*` y son código propio a mantener (el precio de la accesibilidad
  WCAG 2.2 AA sin librería).
- **Express 4 está en modo mantenimiento** y el ecosistema DICOM de Node es
  pobre: el procesamiento de imagen se delega (ADR-0005).
- **La etiqueta `postgres:16-alpine` no es confiable en este monorepo**: está
  contaminada por otra imagen que inicializa su propia tabla `users` y rompe la
  migración de auth. `docker-compose.test.yml` fija Postgres **por digest**; si
  `make up` falla con `column "password" does not exist`, la causa es esa.
- Nombres de contenedor y de red literales (`micd-postgres`, `micd-orthanc`,
  `micd-backend`, red `micd`) colisionan con el stack embebido de `desktop`:
  sólo uno puede correr a la vez.

### Seguimiento

- Si el cliente suma más pantallas con estado compartido, reevaluar framework +
  bundler (revisaría esta decisión, no la de lenguaje).
- Si aparece procesamiento de imagen dentro del request path, revisar ADR-0005
  antes de meter Python en el runtime del backend.
