# GitHub Pages — configuración obligatoria

Si la app abre en blanco y la consola pide `/src/main.tsx` (404), **Pages está publicando la carpeta del repo**, no el build de Vite.

## Pasos (una sola vez)

1. Repo en GitHub → **Settings** → **Pages**
2. En **Build and deployment** → **Source**, elegir **GitHub Actions** (no “Deploy from a branch”).
3. Hacer push a `main` o ejecutar el workflow **Deploy GitHub Pages** manualmente (**Actions** → workflow → **Run workflow**).
4. Cuando termine en verde, recargar:  
   https://emamoreno7.github.io/Sistema-cobranzas-y-gesti-n-de-clientes/

El HTML correcto debe referenciar  
`/Sistema-cobranzas-y-gesti-n-de-clientes/assets/...js`, no `/src/main.tsx`.
