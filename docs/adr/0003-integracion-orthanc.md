# ADR-0003 — Integración con Orthanc como PACS

- **Estado:** Aceptada
- **Fecha:** 2026-07-26
- **Decisores:** Equipo MICD
- **Alcance:** ambos repos (el cliente web depende de no hablar nunca con
  Orthanc)
- **Relacionado:** US-01, ADR-0001, ADR-0002, ADR-0005

## Contexto

El sistema tiene que guardar imágenes DICOM completas y devolverlas ordenadas
para que el visor renderice una serie corte por corte. Escribir eso a mano
implica implementar almacenamiento conforme, jerarquía
paciente/estudio/serie/instancia y extracción de tags: fuera del alcance del
Trabajo Profesional.

Orthanc es un PACS liviano, gratuito y empaquetado en Docker que ya provee
almacenamiento DICOM, una REST API propia, DICOMweb opcional y DIMSE
(C-STORE/C-FIND). La decisión no es "usar un PACS" sino **cómo se integra**:
quién le habla, con qué credenciales y quién es dueño de los metadatos.

## Opciones consideradas

### Opción A — Orthanc detrás del backend, con un único cliente wrapper (elegida)

- **Cómo sería:** Orthanc es un servicio interno del Compose; sólo el backend lo
  llama, desde un módulo único que concentra las credenciales.
- **A favor:** las credenciales de administración del PACS nunca salen del
  backend; se puede mapear cada error de Orthanc a un error de dominio; se puede
  cambiar de PACS tocando un archivo.
- **En contra:** todo el binario atraviesa Node, y hay dos representaciones del
  mismo estudio (índice en PostgreSQL + contenido en Orthanc) que pueden
  divergir.

### Opción B — Exponer Orthanc directamente al navegador

- **Cómo sería:** el cliente usa Orthanc Explorer o DICOMweb contra Orthanc, con
  usuarios propios del PACS.
- **A favor:** menos código en el backend, sin doble salto de bytes.
- **En contra:** obliga a publicar credenciales del PACS (o un segundo esquema
  de autenticación) en el navegador, rompe el modelo de sesión único (ADR-0004)
  y expone toda la superficie administrativa de Orthanc, incluido borrar.

### Opción C — Guardar los `.dcm` en filesystem/S3 con índice propio

- **A favor:** una pieza menos; control total del layout.
- **En contra:** hay que implementar jerarquía DICOM, deduplicación por UID,
  generación de previews y conformidad; y se pierde el camino a DIMSE/DICOMweb
  para interoperar con equipamiento real.

### Opción D — dcm4chee u otro PACS "de industria"

- **A favor:** el estándar de facto en producción hospitalaria.
- **En contra:** requiere operación y memoria muy por encima del proyecto, y no
  se levanta cómodo en una máquina de escritorio para la demo.

## Decisión

**Orthanc corre como servicio interno del stack del backend y sólo el backend lo
consume, a través de `src/clients/orthanc.client.ts`.**

- **Imagen y configuración**: `orthancteam/orthanc:24.1.2`, con
  `ORTHANC__AUTHENTICATION_ENABLED: "true"` y un usuario registrado desde
  `ORTHANC_USERNAME`/`ORTHANC_PASSWORD`. Los datos viven en el volumen nombrado
  `orthanc-data`. Los puertos 8042 (REST) y 4242 (DIMSE) se publican al host
  **sólo para desarrollo y depuración**; en un despliegue real no deben
  publicarse — el backend lo alcanza como `http://orthanc:8042` dentro de la red
  `micd`.
- **Un solo punto de acceso**: `orthancClient` (axios con `auth`) es el único
  lugar del código con las credenciales del PACS. Los controladores no llaman
  axios ni Orthanc directamente, y los servicios reciben la respuesta cruda para
  poder traducir estados.
- **Traducción de errores en la capa de servicio**, no en el cliente: 404 de
  Orthanc → 404 de dominio; 400/415 al pedir un preview → **422**; cualquier
  otra falla o caída → **503**. Los servicios lanzan `HttpError` y
  `sendError(res, err)` los serializa.
- **PostgreSQL es el índice; Orthanc es el content store.** La tabla `studies`
  guarda `orthanc_study_id`, `orthanc_instance_id` y `sop_instance_uid` junto a
  los tags que interesan para buscar; las consultas del explorador
  (`/api/v1/studies*`) se responden **desde PostgreSQL**, no desde Orthanc.
- **Ingesta por REST, no por C-STORE**: `POST /instances` con
  `Content-Type: application/dicom` y `maxBodyLength: Infinity`. El servicio de
  upload valida los bytes mágicos DICOM antes de enviar, extrae los tags con
  `GET /instances/:id/tags` y hace **upsert por `sop_instance_uid`**
  (`ON CONFLICT DO UPDATE`), lo que vuelve el seeding idempotente; un duplicado
  responde **409** salvo `?force=true`.
- **Orden de instancias**: se calcula en `src/shared/instances-util.ts` (lógica
  pura, unitariamente testeada), no se delega a Orthanc.
- **Salud**: `/api/health` prueba PostgreSQL y Orthanc (`GET /system`, timeout
  3 s); el Compose además tiene healthcheck propio de Orthanc y el backend
  espera `service_healthy`.
- **El cliente web nunca conoce a Orthanc**: pide miniaturas y archivos al
  backend con su JWT. Esa es la razón de existir del proxy.

## Consecuencias

### Positivas

- Las credenciales del PACS quedan en un solo archivo del backend y no viajan al
  navegador; no hay superficie administrativa de Orthanc expuesta.
- Cambiar de PACS (o apuntar a uno de la institución) es reimplementar un
  módulo, sin tocar controladores ni el cliente web.
- La búsqueda es rápida y expresiva porque la responde PostgreSQL con índices
  trigram, algo que la REST API de Orthanc no ofrece.
- El upsert por `sop_instance_uid` hace que re-subir o re-sembrar sea seguro.

### Negativas / costos asumidos

- **Doble fuente de verdad**: si alguien escribe directo en Orthanc, el índice de
  PostgreSQL queda desactualizado y no hay proceso de reconciliación. La regla
  operativa es que **toda escritura entra por el backend**.
- **Todo el binario pasa por Node**: memoria y latencia extra, y los timeouts
  del proxy tienen que tolerar estudios grandes (ADR-0002).
- **El respaldo real es el volumen `orthanc-data`**: un `docker compose down -v`
  borra las imágenes; el dump de PostgreSQL por sí solo no restaura nada.
- Los `container_name` literales (`micd-orthanc`, `micd-postgres`,
  `micd-backend`) chocan con el stack embebido del repo `desktop`: sólo uno
  puede estar arriba a la vez.
- Se depende de una versión fija de Orthanc (24.1.2) fijada además a
  `platform: linux/amd64`, lo que en hosts ARM implica emulación.

### Seguimiento

- Si hace falta interoperar con equipos o visores externos, habilitar DIMSE o
  publicar DICOMweb **a través** del backend, nunca abriendo Orthanc.
- Si el índice y el PACS divergen en la práctica, agregar una tarea de
  reconciliación (recorrer estudios de Orthanc y re-indexar) antes de sumar más
  campos derivados a `studies`.
