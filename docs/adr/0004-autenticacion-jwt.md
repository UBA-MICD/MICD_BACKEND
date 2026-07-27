# ADR-0004 — Autenticación con JWT (access corto + refresh rotativo)

- **Estado:** Aceptada
- **Fecha:** 2026-07-26
- **Decisores:** Equipo MICD
- **Alcance:** ambos repos
- **Relacionado:** US-01, TK-05, ADR-0002, ADR-0003

## Contexto

Los estudios DICOM son datos de salud: toda operación contra el servidor
(listar, buscar, ver miniaturas, descargar imágenes, subir, publicar) tiene que
estar identificada. Al mismo tiempo, la idea organizadora del cliente es que
**ver un archivo DICOM local es gratis y no necesita sesión**: la app arranca
siempre y sólo pide credenciales cuando el usuario cruza hacia el servidor.

Condiciones adicionales:

- Hay **más de un cliente** para la misma API: el cliente web, la app de
  escritorio (Electron) y los scripts de seeding/tests.
- El backend corre detrás del nginx del repo web (ADR-0002) y se despliega en
  varias réplicas potenciales: no conviene guardar estado de sesión en memoria
  del proceso.
- No hay infraestructura de identidad institucional disponible para el proyecto,
  ni tiempo para operarla.

## Opciones consideradas

### Opción A — Sesiones de servidor con cookie

- **Cómo sería:** `express-session` con store en PostgreSQL/Redis y cookie
  `HttpOnly; Secure; SameSite`.
- **A favor:** revocación inmediata; el token no es accesible desde JavaScript,
  lo que reduce el impacto de un XSS.
- **En contra:** agrega estado del lado del servidor (y un store más para
  operar); las cookies encajan mal con la app de escritorio y con clientes no
  navegador; hace falta protección CSRF explícita en cada mutación.

### Opción B — JWT de acceso corto + refresh token rotativo (elegida)

- **Cómo sería:** access token firmado de vida corta que viaja en el header, y
  refresh token de un solo uso que se canjea por uno nuevo.
- **A favor:** backend sin estado de sesión; el mismo mecanismo sirve a los tres
  clientes; el header `Authorization` es explícito y no arrastra CSRF.
- **En contra:** no hay revocación instantánea del access token; el refresh
  token tiene que guardarse en algún lado del cliente y hay que administrar su
  rotación.

### Opción C — Proveedor de identidad externo (Auth0, Keycloak, OIDC)

- **A favor:** MFA, gestión de usuarios y auditoría sin escribirlas.
- **En contra:** dependencia externa o un servicio más para levantar en cada
  demo; el flujo OIDC completo es desproporcionado para un padrón de usuarios
  chico y sin roles.

### Opción D — Basic auth por request

- **A favor:** trivial.
- **En contra:** obliga al cliente a conservar la contraseña en claro durante
  toda la sesión y no permite expiración ni rotación. Descartada de entrada.

## Decisión

Se adopta **JWT HS256 con access token corto en memoria y refresh token
rotativo**:

- **Tokens**: access `JWT_ACCESS_TTL` = **15 min**, refresh `JWT_REFRESH_TTL` =
  **7 días**, firmados con secretos distintos (`JWT_SECRET`,
  `JWT_REFRESH_SECRET`). `config/env.ts` **aborta el arranque** si en
  `NODE_ENV=production` siguen con los valores de ejemplo.
- **Rotación de un solo uso**: cada `POST /auth/refresh` invalida el refresh
  recibido y emite uno nuevo. La rotación es un único
  `UPDATE ... RETURNING` atómico (`consumeRefreshToken`) para que dos pedidos
  concurrentes no puedan canjear el mismo token.
- **Refresh tokens hasheados en reposo** (SHA-256) en la tabla `refresh_tokens`:
  una filtración de la base no permite replayearlos directamente.
- **Contraseñas con bcrypt**, coste `BCRYPT_ROUNDS=12` (mínimo recomendado por
  OWASP). El usuario compartido de desarrollo (`test@micd.local`) lo siembra la
  **migración 002 en SQL**, con `crypt()` + `gen_salt('bf')` de `pgcrypto`: el
  hash se genera en la base y no hay credenciales semilla en el entorno ni un
  `seedAdminUser` en la aplicación.
- **Rate limit de login por IP**: `express-rate-limit`, **5 intentos fallidos
  cada 15 min** con `skipSuccessfulRequests`, respondiendo **429**. Requiere
  `app.set("trust proxy", 1)` porque el backend está detrás de nginx; sin eso el
  limitador contaría la IP del proxy y castigaría a todos los usuarios juntos.
- **Superficie protegida**: `requireAuth` cubre todo salvo `/api/health`,
  `/auth/*` y `/api/docs*`. Sin token válido, **401**.
- **Modelo de usuarios plano**: `users` es `(id, email, password)`, **sin roles
  ni tipos de usuario**. Las rutas que el diseño original marcaba como
  administrativas (configuración de Zenodo) quedan detrás del mismo
  `requireAuth`.
- **Del lado del cliente** (`src/auth/auth.ts`, sin DOM y testeado con `fetch` y
  `localStorage` simulados):
  - el **access token vive sólo en una variable de módulo** — nunca se persiste,
    se pierde al recargar;
  - el **refresh token vive en `localStorage`** y permite la restauración
    silenciosa de sesión al cargar la página;
  - `refreshAccessToken()` es **single-flight** — obligatorio, porque el refresh
    rota y dos canjes en paralelo se anularían entre sí;
  - `ensureAuthenticated()` es la única puerta: token en memoria → refresh
    silencioso → pedido de login (también single-flight);
  - `authFetch()` adjunta el `Bearer` y ante un 401 escala refresh → login → un
    reintento; si el usuario cancela, el llamador recibe el 401 original;
  - **no hay modal de login**: el invitado que va a la pantalla de servidor
    aterriza en su tarjeta de autenticación, y ahí mismo cae la sesión que muere
    a mitad de una operación (`promptLoginOnServerScreen`);
  - la cuenta regresiva de expiración se calcula del claim `exp`
    (`getSessionExpiresAt()`) y se repinta en un único lugar
    (`updateAuthUI()`).

## Consecuencias

### Positivas

- El backend no guarda estado de sesión: escala horizontal sin store compartido
  y sin sesiones pegadas a un proceso.
- Un solo mecanismo para el cliente web, el de escritorio y los scripts de test
  (`tests/helpers/auth.ts` obtiene y cachea el header `Bearer`).
- El daño de un XSS está acotado: el token de larga vida es de un solo uso y el
  de acceso expira en 15 min; un refresh robado y ya canjeado no sirve.
- Sin cookies de sesión no hace falta maquinaria CSRF.
- El límite por IP en login frena el fuerza-bruta sin castigar los aciertos.

### Negativas / costos asumidos

- **No hay revocación inmediata**: un access token robado sigue siendo válido
  hasta 15 minutos. Cerrar sesión borra el refresh, no el access.
- **El refresh token en `localStorage` es alcanzable por JavaScript**: la
  mitigación es la CSP y el escapado disciplinado de todo texto derivado de
  DICOM en el cliente, no el almacenamiento.
- **La rotación obliga a disciplina en el cliente**: cualquier camino que
  refresque sin pasar por el single-flight rompe la sesión. Es la razón de que
  la subida por XHR tenga su propio pre-flight y un solo reintento por archivo.
- **Sin roles no se puede separar administración de uso**: cualquier usuario
  autenticado puede configurar credenciales de Zenodo o publicar. Agregar roles
  implica migración de esquema y revisión de todas las rutas.
- El rate limit **por IP** afecta a usuarios que compartan salida NAT.
- En los tests de integración dockerizados, la suite corre en **paralelo a
  propósito**: cada suite toma su token en el `beforeAll` antes de que el test
  de rate limit agote el límite por IP compartido. Serializar con `--runInBand`
  envenena los logins posteriores con 401.

### Seguimiento

- Si aparece la necesidad de cerrar sesión de verdad y ya, evaluar una lista de
  denegación de `jti` de access tokens (vuelve a introducir estado) o bajar el
  TTL.
- Si el sistema pasa a manejar datos de pacientes reales, este ADR debería
  reemplazarse por uno con roles, MFA y auditoría de accesos (hoy `audit_log`
  sólo registra acciones de Zenodo).
