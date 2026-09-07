# Deploy en el servidor FIUBA (detrás del proxy)

Cómo compilar y levantar el stack de producción en el servidor de la facultad, que
sale a internet **únicamente** a través del proxy `proxy.fi.uba.ar:8080`.

> **Lo esencial en una línea:** el proxy es **HTTP plano**, así que tanto `HTTP_PROXY`
> como `HTTPS_PROXY` van con esquema `http://`. Y hay que configurarlo en **dos
> lugares independientes** — el daemon de Docker y el cliente — porque arreglar uno
> no arregla el otro.

---

## Por qué el esquema es `http://` en las dos variables

El esquema de la URL describe **cómo le hablás al proxy**, no el tráfico que el proxy
transporta. `proxy.fi.uba.ar:8080` es un Squid que escucha HTTP plano: el tráfico
HTTPS pasa por él con el método `CONNECT`, pero la conversación *con el proxy* sigue
siendo HTTP.

Poner `HTTPS_PROXY=https://proxy.fi.uba.ar:8080/` hace que el cliente intente un
handshake TLS contra el Squid, que responde en texto plano. El error es:

```
proxyconnect tcp: tls: first record does not look like a TLS handshake
```

Si algún día el proxy sí termina TLS, ahí sí corresponde `https://`, pero además hay
que instalar su CA en el host (`/usr/local/share/ca-certificates/`, luego
`sudo update-ca-certificates` y reiniciar Docker).

---

## Capa 1 — Daemon de Docker (para `docker pull`)

Es la que permite **descargar imágenes**. Vive en un drop-in de systemd:

```bash
sudo mkdir -p /etc/systemd/system/docker.service.d
sudo nano /etc/systemd/system/docker.service.d/http-proxy.conf
```

```ini
[Service]
Environment="HTTP_PROXY=http://proxy.fi.uba.ar:8080/"
Environment="HTTPS_PROXY=http://proxy.fi.uba.ar:8080/"
Environment="NO_PROXY=localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
```

> **Cuidado con los drop-ins duplicados.** systemd lee los `.conf` en orden
> alfabético y, ante la misma variable, **gana la última asignación**. En este
> servidor había un `proxy.conf` con `HTTPS_PROXY=https://...` que, por ordenar
> después de `http-proxy.conf`, pisaba el valor correcto. Tiene que quedar **un solo
> archivo**:
>
> ```bash
> ls /etc/systemd/system/docker.service.d/     # debería haber uno solo
> sudo rm /etc/systemd/system/docker.service.d/proxy.conf
> ```
>
> Ojo también con `NO_PROXY=localhost,127.0.0.1::1` (falta una coma): se parsea como
> un host inexistente `127.0.0.1::1` y no exceptúa ni `127.0.0.1` ni `::1`.

Aplicar y verificar:

```bash
sudo systemctl daemon-reload
sudo systemctl restart docker
sudo systemctl show docker --property=Environment   # las dos deben decir http://
docker pull hello-world
```

---

## Capa 2 — Cliente Docker (para `npm` dentro del build)

Esta es la que se olvida, y **falla en silencio**. El daemon resuelve los `docker
pull`, pero `npm ci` corre *adentro del contenedor* durante el build y necesita su
propio proxy para llegar a `registry.npmjs.org`.

Docker inyecta `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` en los `RUN` como *build args*
predefinidos (no hace falta declararlos con `ARG` en el Dockerfile), pero solo si
están definidos donde se invoca el build. Lo más robusto es dejarlo fijo en
`~/.docker/config.json`:

```jsonc
{
  "proxies": {
    "default": {
      "httpProxy": "http://proxy.fi.uba.ar:8080/",
      "httpsProxy": "http://proxy.fi.uba.ar:8080/",
      "noProxy": "localhost,127.0.0.1,::1"
    }
  }
}
```

> Si el archivo ya existe, **fusionar** la clave `proxies` — no pisar el archivo
> entero, que puede tener una sección `auths` con credenciales de registry.

Alternativa por sesión (sirve para probar, se pierde al cerrar la shell):

```bash
export HTTP_PROXY=http://proxy.fi.uba.ar:8080/
export HTTPS_PROXY=http://proxy.fi.uba.ar:8080/
export NO_PROXY=localhost,127.0.0.1,::1
```

### Por qué esto falla tan mal

Sin la capa 2, `npm ci` no llega al registry y **crashea saliendo con código 0**:

```
npm error Exit handler never called!
```

BuildKit interpreta ese 0 como éxito y sigue adelante con un `node_modules` **vacío**.
El build entonces revienta tres pasos después, en `RUN npm run build`, con un mensaje
que apunta a otra cosa por completo:

```
sh: tsc: not found
... exit code: 127
```

**No es que falte typescript.** No se instaló absolutamente nada. Lo mismo le pasa al
stage `runtime` con su `npm ci --omit=dev`: la imagen se construye "bien" y después el
contenedor muere al arrancar con un `Cannot find module 'express'`.

---

## Compilar y levantar

```bash
cd backend

# .env con todos los secretos (ver .env.prod.example — no hay defaults inseguros,
# cada VAR usa ${VAR:?...} y el build falla si falta alguna)
cp .env.prod.example .env
nano .env

docker compose -f docker-compose.prod.yml build --no-cache --progress=plain backend 2>&1 | tee /tmp/build.log
```

**Verificación obligatoria antes de seguir** — confirmar que el install trajo algo:

```bash
grep -E "added [0-9]+ packages" /tmp/build.log
```

Tienen que aparecer **dos** líneas: ~500 paquetes (stage `builder`, con devDependencies)
y ~120 (stage `runtime`, solo producción). Si alguna dice 0 o no aparece, el proxy no
se está propagando al build: volver a la capa 2.

```bash
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps       # los 3 servicios en (healthy)
docker logs -f micd-backend
```

`--no-cache` es importante después de un build fallido: las capas cacheadas de los
intentos anteriores contienen `node_modules` vacíos. Si hace falta limpiar más a
fondo, `docker builder prune -f`.

---

## Diagnóstico

### Reproducir el `npm ci` aislado

Es el test más útil: saca al Dockerfile de la ecuación y muestra el error real de npm,
que BuildKit se come.

```bash
docker run --rm \
  -e HTTP_PROXY=http://proxy.fi.uba.ar:8080/ \
  -e HTTPS_PROXY=http://proxy.fi.uba.ar:8080/ \
  -e NO_PROXY=localhost,127.0.0.1,::1 \
  -v "$PWD":/ctx:ro -w /work node:20-alpine sh -c \
  'cp /ctx/package*.json . && npm ci --include=dev 2>&1 | tail -5 && ls node_modules/.bin/tsc'
```

Si imprime `node_modules/.bin/tsc`, la red del contenedor está bien y el problema está
en cómo el build recibe (o no) el proxy. Sin las `-e`, este mismo comando reproduce el
`Exit handler never called!`.

### Confirmar que el Squid deja pasar CONNECT

```bash
curl -v -x http://proxy.fi.uba.ar:8080 https://registry-1.docker.io/v2/
```

Un `403` o `407` acá es una ACL o autenticación del proxy de FIUBA, no un problema de
Docker.

### Tabla de síntomas

| Síntoma | Capa | Causa |
| --- | --- | --- |
| `tls: first record does not look like a TLS handshake` | 1 | `HTTPS_PROXY` con esquema `https://` |
| `failed to resolve reference "docker.io/..."` | 1 | El daemon no llega al registry |
| `npm error Exit handler never called!` + `added 0 packages` | 2 | npm sin proxy dentro del contenedor |
| `sh: tsc: not found` / exit 127 en `npm run build` | 2 | Consecuencia de lo anterior: `node_modules` vacío |
| `Cannot find module 'express'` al arrancar | 2 | Ídem, pero en el stage `runtime` |
| `column "password" does not exist` en las migraciones | — | Nada que ver con el proxy: es la colisión del tag `postgres:16-alpine` (ver CLAUDE.md) |

---

## Nota sobre el Dockerfile

Los stages `builder` y `test` usan `npm ci --include=dev` de forma explícita. No es lo
que arregla el problema del proxy, pero blinda el build contra un `NODE_ENV=production`
heredado del entorno del servidor (o un `omit=dev` en cualquier `npmrc`), que
produciría exactamente el mismo `sh: tsc: not found` por una causa distinta. El stage
`runtime` mantiene `npm ci --omit=dev` a propósito: ahí solo van dependencias de
producción.
