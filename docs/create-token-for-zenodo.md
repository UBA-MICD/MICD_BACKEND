
1. Ir a [sandbox.zenodo.org](https://sandbox.zenodo.org/) y crear una cuenta (puede ser con GitHub o email)
2. Una vez logueado, ir a:
Tu nombre (arriba a la derecha) → Applications → Personal Access Tokens
3. Click en "New token" y configurarlo así:

Name: uba-micd-dev (cualquier nombre descriptivo)
Scopes — tildar estos tres:

- [ ] deposit:write
- [ ] deposit:actions
- [ ] user:email (opcional pero recomendado)



4. Click "Create" → copiá el token ahora porque no lo vas a poder ver de nuevo

En Zenodo Producción (cuando el sistema esté listo para publicar datos reales)
Mismo proceso pero en [zenodo.org](https://zenodo.org/) — cuenta separada, token separado.

Dónde pegarlo
En tu .env local:
bash# Sandbox (desarrollo)
ZENODO_SANDBOX_TOKEN=tu_token_aquí

# Producción (cuando esté listo)
ZENODO_PRODUCTION_TOKEN=
Y para verificar que funciona antes de implementar nada:
bashcurl "https://sandbox.zenodo.org/api/records?size=1&access_token=TU_TOKEN"
- [ ] Si responde 200 con JSON → token válido 
- [ ] Si responde 401 → token mal copiado o expirado 

La diferencia importante entre Sandbox y Producción es que en Sandbox podés publicar, borrar y hacer pruebas sin que nada quede indexado públicamente ni consuma tu cuota real. Todo lo que publiques en Sandbox desaparece periódicamente. Usalo para todo el desarrollo hasta que el sistema esté aprobado para usar datos reales.