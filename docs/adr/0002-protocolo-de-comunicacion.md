# ADR-0002 — Protocolo de comunicación entre componentes

- **Estado:** Aceptada
- **Fecha:** 2026-07-26
- **Decisores:** Equipo MICD
- **Alcance:** ambos repos
- **Relacionado:** US-01, ADR-0001, ADR-0003, ADR-0004

## Contexto

El sistema tiene tres saltos de comunicación distintos:

1. **Navegador → backend**: listar/buscar estudios, pedir miniaturas y archivos
   DICOM, subir archivos de hasta cientos de MB, y sostener una sesión.
2. **Backend → Orthanc**: leer y escribir instancias DICOM en el PACS.
3. **Backend → PostgreSQL**: metadatos indexados (protocolo dado por `pg`).

Sobre el primer salto pesan dos requisitos duros: el navegador **no puede
conocer las credenciales del PACS** (ADR-0003) y la app tiene que funcionar
servida detrás de un reverse proxy en el mismo origen, sin exponer más puertos
que el 80 del frontend. Además el cliente necesita **progreso de subida**
visible por archivo.

## Opciones consideradas

### Opción A — REST/JSON sobre HTTP con multipart para la ingesta (elegida)

- **Cómo sería:** endpoints JSON versionados en el backend, cuerpos binarios
  para imágenes, `multipart/form-data` para subir, todo en el mismo origen vía
  nginx.
- **A favor:** trivial de depurar (curl, DevTools, Swagger), cacheable, sin
  runtime extra en el cliente, y deja al backend mediar cada byte.
- **En contra:** cada capacidad nueva del PACS necesita un endpoint propio; sin
  push del servidor, el estado de trabajos largos se consulta por polling.

### Opción B — DICOMweb (QIDO-RS / WADO-RS / STOW-RS) directo al navegador

- **Cómo sería:** el cliente habla el estándar DICOMweb contra Orthanc.
- **A favor:** estándar de la industria, interoperable con visores de terceros;
  el backend deja de mover píxeles.
- **En contra:** obliga a exponer Orthanc (y sus credenciales, o un esquema de
  tokens propio) al navegador; no ofrece la búsqueda paginada con trigram ni el
  modelo de metadatos propio; el `multipart/related` de STOW-RS es incómodo de
  generar con progreso por archivo desde el navegador.

### Opción C — GraphQL

- **A favor:** una sola ruta y consultas a medida para el explorador.
- **En contra:** los recursos son pocos y estables (estudios, instancias,
  sesión) y el tráfico pesado es binario, que GraphQL no transporta bien; suma
  servidor de esquema y complejidad sin resolver ningún problema real.

### Opción D — gRPC-web o WebSocket para streaming

- **A favor:** streaming eficiente y bidireccional.
- **En contra:** exige proxy y capa de generación de código; con `<canvas>` y
  `URL.createObjectURL` sobre respuestas HTTP el visor ya rinde, y el estado de
  sesión JWT (ADR-0004) está pensado por request.

## Decisión

Se adopta **HTTP/1.1 con REST y JSON como protocolo de aplicación en todos los
saltos, con Orthanc alcanzable sólo desde el backend**:

- **Navegador → backend**: JSON sobre HTTP, con dos familias de rutas que
  conservan sus URLs: el proxy fino heredado `/api/studies*` y la actual
  `/api/v1/studies*` respaldada por PostgreSQL (paginado, filtros y búsqueda).
  La sesión vive en `/auth/*`. Contrato publicado como **OpenAPI 3.0**
  (`src/openapi.ts`, servido en `/api/docs` y `/api/docs/openapi.json`): agregar
  o cambiar un endpoint implica actualizar esa spec.
- **Autorización por request**: `Authorization: Bearer <access token>` en toda
  ruta protegida; `/api/health`, `/auth/*` y `/api/docs*` son las únicas
  públicas (ADR-0004).
- **Ingesta**: `multipart/form-data` recibido con `multer` en
  `POST /api/v1/studies/upload` (y su alias heredado `POST /api/instances`), con
  límite de **500 MB** por request. El cliente sube **de a un archivo** con
  **XHR** en lugar de `fetch`, porque `fetch` no reporta progreso de subida.
- **Respuestas binarias**: el archivo DICOM viaja como `application/dicom` y las
  miniaturas como imagen; el cliente las consume con `authFetch` +
  `URL.createObjectURL` (de ahí que la CSP tenga que permitir `blob:` en
  `img-src`).
- **Mismo origen en producción**: nginx (`nginx.conf` del repo web) proxea
  `location /api/` y `location /auth/` a `http://backend:3000` por nombre de
  servicio en la red `micd`. El cliente resuelve el origen una sola vez en
  `src/auth/auth.ts` (`API_ORIGIN`/`API_BASE`): `window.MICD_API_ORIGIN = ""`
  para el mismo origen en Docker, `http://localhost:3000` para desarrollo
  suelto. **En producción no hay CORS ni preflight**; `cors` en el backend sólo
  cubre el caso de desarrollo con orígenes distintos.
- **Backend → Orthanc**: REST nativa de Orthanc sobre HTTP con basic auth, desde
  un único cliente (ADR-0003). **No se usa DIMSE**: el puerto DICOM 4242 queda
  dentro de la red y la ingesta entra por `POST /instances`. DICOMweb está
  habilitado en Orthanc (`ORTHANC__DICOM_WEB__ENABLE`) pero **no se expone al
  navegador**; queda como puerta de interoperabilidad futura.
- **Trabajos largos**: se modelan como recurso consultable por polling (por
  ejemplo `GET /api/v1/zenodo/depositions/:id`), no como push.
- **Límites que tienen que coincidir a los dos lados del proxy**:
  `client_max_body_size 500m` y `proxy_read_timeout/proxy_send_timeout 300s` en
  nginx contra el límite de subida del backend. Y `app.set("trust proxy", 1)`,
  sin el cual el rate limit por IP contaría la IP de nginx.

## Consecuencias

### Positivas

- Un solo origen y un solo puerto público: sin CORS, sin preflight y sin
  credenciales de PACS en el cliente.
- Depurable con herramientas comunes y documentado en Swagger; el mismo contrato
  sirve al cliente web, al de escritorio y a los scripts de seeding.
- El backend puede ofrecer lo que DICOMweb no da: paginado, filtros por
  modalidad/fecha y búsqueda por nombre con trigram.
- Cualquier ruta nueva se agrega con el **mismo path a los dos lados** del proxy
  y funciona en ambos frontends por path relativo.

### Negativas / costos asumidos

- **El backend es el cuello de botella de bytes**: todo píxel pasa por Node, con
  su costo de memoria y latencia, y los timeouts del proxy tienen que
  acompañarlo.
- **Cada capacidad de Orthanc necesita un endpoint propio**; no hay atajo
  estándar para un cliente externo.
- **Sin push**: el frontend consulta por polling; los avances largos (publicar
  en Zenodo, importar) no notifican solos.
- **La subida por XHR no puede usar `authFetch`**: `src/upload/upload.ts`
  duplica el pre-flight `ensureAuthenticated()` y el reintento único ante 401
  por archivo.
- Dos generaciones de rutas conviven (`/api/studies*` y `/api/v1/studies*`), y
  hay que mantener las dos hasta retirar la heredada.

### Seguimiento

- Si aparece la necesidad de integrar visores de terceros, exponer DICOMweb
  **a través** del backend (proxy autenticado) antes que abrir Orthanc.
- Si los trabajos largos se multiplican, evaluar SSE antes que WebSocket: encaja
  con el modelo de un solo origen y con el token por request.
