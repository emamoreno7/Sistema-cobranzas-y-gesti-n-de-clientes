# GitHub Pages — configuración

## Síntoma

Pantalla en blanco, consola con:

- `Failed to load module script` / MIME `application/octet-stream`
- peticiones a `/src/main.tsx` o `%BASE_URL%manifest.json`

Eso significa que Pages está sirviendo el **código fuente** (raíz del repo), no el build.

## Configuración correcta (una vez)

1. Repo → **Settings** → **Pages**
2. **Build and deployment** → **Source**: **Deploy from a branch**
3. **Branch**: `main` → carpeta **`/docs`** (no `/ (root)`)
4. Guardar y esperar 1–2 minutos
5. Recargar con Cmd+Shift+R:  
   https://emamoreno7.github.io/Sistema-cobranzas-y-gesti-n-de-clientes/

El workflow **Deploy GitHub Pages** genera `docs/` en cada push a `main` (salvo commits que solo tocan `docs/`).

## Comprobar que está bien

En el HTML de la URL debe aparecer algo como:

`/Sistema-cobranzas-y-gesti-n-de-clientes/assets/index-….js`

y **no** `./src/main.tsx`.
