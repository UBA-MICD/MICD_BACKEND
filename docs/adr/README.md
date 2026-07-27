# Architecture Decision Records (ADR)

Registro de las decisiones arquitectónicas del sistema **MICD**. Cada ADR
documenta una decisión tomada, las alternativas que se descartaron y lo que la
decisión cuesta — para que el equipo no vuelva a discutir lo mismo y para que el
informe final tenga trazabilidad.

Un ADR es **inmutable**: no se corrige una decisión editándola, se escribe un ADR
nuevo que la reemplaza y se marca la anterior como `Reemplazada por ADR-NNNN`.

## Índice

- **[ADR-0001 — Stack tecnológico](0001-stack-tecnologico.md)** _(Aceptada)_ —
  TypeScript en los dos extremos, Express + PostgreSQL + Orthanc, cliente sin
  framework ni bundler, todo en Docker.
- **[ADR-0002 — Protocolo de comunicación](0002-protocolo-de-comunicacion.md)**
  _(Aceptada)_ — REST/JSON sobre HTTP, `multipart` para la ingesta, mismo origen
  vía nginx; DICOMweb y DIMSE no se exponen al navegador.
- **[ADR-0003 — Integración con Orthanc como PACS](0003-integracion-orthanc.md)**
  _(Aceptada)_ — Orthanc es servicio interno y sólo el backend lo consume, desde
  un cliente wrapper único; PostgreSQL es el índice.
- **[ADR-0004 — Autenticación con JWT](0004-autenticacion-jwt.md)**
  _(Aceptada)_ — access token de 15 min en memoria, refresh de 7 días rotativo,
  hasheado en reposo, con rate limit por IP en login.
- **[ADR-0005 — Módulo de anonimización externo](0005-modulo-anonimizacion-externo.md)**
  _(Propuesta)_ — servicio aparte en la red `micd` orquestado por el backend;
  `studies.anonymized_at` es la única fuente de verdad y el sistema falla
  cerrado.

Plantilla: [TEMPLATE.md](TEMPLATE.md).

## Formato

Todos los ADR siguen la misma estructura, en este orden:

1. **Encabezado** — estado, fecha, decisores, alcance y US/TK relacionados.
2. **Contexto** — el problema y las restricciones reales, sin opinión.
3. **Opciones consideradas** — cada alternativa con sus pros y contras.
4. **Decisión** — qué se eligió, en concreto (versiones, archivos, límites).
5. **Consecuencias** — lo que se gana, lo que se paga y qué habría que revisar.

## Cómo agregar un ADR

1. Copiar `TEMPLATE.md` a `NNNN-titulo-en-kebab-case.md` con el número siguiente
   (cuatro dígitos, nunca se reutiliza uno).
2. Completar las cinco secciones. Si no hay alternativas reales, no es un ADR.
3. Nacer en `Propuesta`; pasa a `Aceptada` cuando el equipo la aprueba en el code
   review.
4. Agregar la fila al índice de arriba.
5. Replicar el archivo en el otro repo (ver más abajo).

## Alcance multi-repo

MICD vive en repos separados (`MICD_BACKEND`, `MICD_WEB` y `desktop`) y estas
decisiones son **del sistema**, no de un repo. Por eso `docs/adr/` se mantiene
**idéntico en `MICD_BACKEND` y `MICD_WEB`**: cada repo tiene que poder leerse
solo, y los enlaces relativos entre repos no resolverían.

Al modificar o agregar un ADR, **copiarlo a los dos repos en el mismo pull
request lógico**. Si divergen, la copia de `MICD_BACKEND` es la de referencia.
