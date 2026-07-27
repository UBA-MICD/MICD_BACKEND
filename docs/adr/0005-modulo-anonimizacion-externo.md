# ADR-0005 — Integración del módulo de anonimización externo

- **Estado:** Propuesta (pasa a Aceptada cuando aterrice US-16)
- **Fecha:** 2026-07-26
- **Decisores:** Equipo MICD
- **Alcance:** ambos repos (el cliente web sólo consume el estado, nunca
  anonimiza)
- **Relacionado:** US-16, ZEN-01, ADR-0001, ADR-0003

## Contexto

La sección 4.1 del Trabajo Profesional exige "procesamiento automático de
imágenes DICOM para eliminar información de identificación personal previo a
cualquier transmisión". Eso ya tiene consecuencias visibles en el código:

- la migración `003_zenodo.ts` agregó la columna `studies.anonymized_at`,
  anotada como "populated by US-16";
- `zenodo-publish.service.ts` **rechaza publicar** si alguna instancia del
  estudio tiene `anonymized_at` en `NULL`, con el código de error
  `not_anonymized` (**422**);
- hoy esa columna **no la escribe nadie**: en las pruebas se completa a mano
  (`docs/zenodo-testing.md`), así que la publicación real está bloqueada.

Anonimizar DICOM bien no es borrar tres tags: hay que tratar el perfil de
confidencialidad (PS3.15), re-mapear UIDs de forma consistente dentro del
estudio, limpiar tags privados y detectar texto quemado en los píxeles. Las
bibliotecas maduras para eso están en Python (`pydicom`), no en Node (ADR-0001),
y el módulo se desarrolla como **componente separado** del backend.

Además hay una restricción de flujo: el cliente web sube el DICOM **crudo** al
backend (ADR-0002), así que la anonimización tiene que ocurrir del lado del
servidor, no antes.

## Opciones consideradas

### Opción A — Anonimizar en el navegador antes de subir

- **Cómo sería:** el cliente reescribe los tags con `dicom-parser` y sube el
  resultado.
- **A favor:** los datos identificatorios nunca salen de la máquina del usuario.
- **En contra:** `dicom-parser` lee, no reescribe de forma conforme; la lógica
  quedaría en un entorno no confiable y desactivable por el usuario; imposible
  garantizar ni auditar el cumplimiento. Descartada por seguridad.

### Opción B — Implementarla en TypeScript dentro del backend

- **A favor:** un componente menos; todo en el lenguaje del equipo.
- **En contra:** reimplementar un perfil de anonimización DICOM con las
  bibliotecas de Node disponibles es a la vez costoso y riesgoso; un error acá
  significa publicar datos de paciente en Zenodo con DOI, es decir, público y
  citable para siempre.

### Opción C — Usar la anonimización nativa de Orthanc

- **Cómo sería:** `POST /studies/{id}/anonymize` de la REST API de Orthanc.
- **A favor:** ya está instalado, implementa el estándar y no agrega
  contenedores; sería la opción por defecto si sólo hiciera falta lo básico.
- **En contra:** genera un **estudio nuevo** en el PACS (duplica el original, que
  queda ahí con la PII), la política de tags es la de Orthanc y no la del
  proyecto, no cubre texto quemado en píxeles, y ataría la regla de negocio a la
  versión del PACS justo cuando ADR-0003 buscó lo contrario. Se conserva como
  plan de contingencia si US-16 no llega.

### Opción D — Módulo externo consumido por HTTP desde el backend (elegida)

- **Cómo sería:** el módulo de anonimización corre como su propio contenedor en
  la red `micd` y el backend lo invoca por REST, igual que hace con Orthanc.
- **A favor:** el módulo se escribe y versiona en el ecosistema adecuado
  (Python/`pydicom`), es reemplazable sin tocar el backend, y su política de
  anonimización se audita por separado.
- **En contra:** un servicio más para levantar, monitorear y versionar; un salto
  de red y una copia de bytes extra en la ingesta.

## Decisión

El módulo de anonimización se integra como **servicio externo orquestado por el
backend**, replicando el patrón que ya funciona con Orthanc (ADR-0003). El
contrato de integración es:

- **Despliegue**: contenedor propio en el `docker-compose.yml` del backend,
  unido a la red `micd`, **sin publicar puertos al host**, con `healthcheck` y
  `depends_on: service_healthy` para que el backend no arranque contra un módulo
  muerto. Su URL y credenciales se leen **sólo** en `config/env.ts`
  (`ANONYMIZER_URL`, timeout propio).
- **Un único punto de acceso**: `src/clients/anonymizer.client.ts`, análogo a
  `orthanc.client.ts` — es el único módulo que conoce la URL del servicio,
  devuelve la respuesta cruda y deja que la capa de servicio traduzca los
  estados a `HttpError` (indisponible o timeout → **503**; DICOM que el módulo
  rechaza → **422**).
- **Protocolo**: HTTP REST (ADR-0002). `GET /health` para la sonda, y el
  endpoint de anonimización recibe la instancia DICOM
  (`application/dicom`) y devuelve la instancia anonimizada. La operación es
  **por instancia**, y el backend la orquesta para todas las instancias del
  estudio.
- **El navegador nunca habla con el módulo.** Es una regla, no un detalle: el
  cliente web sólo lee el estado de anonimización que el backend le expone y
  muestra el mensaje correspondiente (`not_anonymized` en el panel de Zenodo).
- **Fuente única de verdad**: `studies.anonymized_at` — ya creada por la
  migración 003 — se escribe **recién cuando el módulo confirma** la
  anonimización de esa instancia. Nada más la escribe.
- **La instancia anonimizada reemplaza a la original en Orthanc**: el backend
  sube el resultado y elimina la instancia con PII
  (`orthancClient.deleteInstance`), manteniendo el índice apuntando a un solo
  contenido. El PACS no debe quedar con las dos versiones.
- **Fail closed**: si el módulo falla, el estudio queda **no anonimizado** y la
  operación falla con 503. No hay camino degradado que permita transmitir o
  publicar un estudio sin anonimizar; la barrera de `zenodo-publish.service.ts`
  se mantiene tal como está.
- **Auditoría**: se amplía `AUDIT_ACTIONS` (`shared/audit.ts`) con las acciones
  de anonimización (iniciada, completada, fallida) para que quede rastro de quién
  y cuándo, igual que con las acciones de Zenodo.

## Consecuencias

### Positivas

- La lógica más delicada del sistema (no filtrar datos de paciente) vive en un
  componente especializado, en el ecosistema con las bibliotecas DICOM maduras, y
  se puede actualizar o reemplazar sin tocar el backend.
- El patrón es el que el equipo ya conoce: cliente wrapper único, credenciales en
  un solo archivo, mapeo de errores en la capa de servicio.
- La puerta de salida ya existe y no hay que inventarla: sin `anonymized_at` no
  se publica en Zenodo.
- `fail closed` + auditoría dan un argumento defendible frente al requisito 4.1.

### Negativas / costos asumidos

- **Un servicio más** en el Compose, con su healthcheck, su versión y su
  posibilidad de estar caído: la ingesta pasa a depender de dos servicios
  externos (Orthanc y el anonimizador).
- **Latencia y memoria**: cada instancia hace un salto de red adicional y una
  copia de bytes más en Node.
- **Sin cola ni worker**, la anonimización corre dentro del request: un estudio
  volumétrico de decenas de cortes puede acercarse a los timeouts de nginx
  (300 s, ADR-0002). Si eso pasa, hay que introducir un job asincrónico
  consultable por polling, no subir el timeout.
- **Mientras US-16 no aterrice**, `anonymized_at` se completa a mano y la
  publicación en Zenodo no es usable de punta a punta: es la deuda técnica más
  cara que queda abierta.
- El backend no valida la anonimización: **confía** en el módulo. Un módulo
  defectuoso marca `anonymized_at` sobre datos que siguen teniendo PII.

### Seguimiento

- Al integrar US-16, cerrar dos preguntas abiertas: si la anonimización se
  dispara **en la ingesta** o como paso posterior por estudio, y si el módulo
  expone operación por estudio además de por instancia.
- Si el módulo externo no llega en tiempo, activar la Opción C (anonimización
  nativa de Orthanc) **detrás del mismo cliente wrapper**, para que el resto del
  backend no note la diferencia y este ADR sólo cambie de implementación.
- Vale la pena una verificación independiente de resultados (un chequeo de tags
  identificatorios sobre la instancia anonimizada) antes de escribir
  `anonymized_at`.
