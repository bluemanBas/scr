# Changelog — SCR (fork)

Cambios **propios de SCR** (Fábrica 3D), los que no van al repo original.

> **Por qué existe este archivo.** `docs/CHANGELOG.md` es de Joel (upstream). Tanto él como nosotros agregamos entradas **arriba del todo**, así que editarlo garantiza conflictos en cada `git merge upstream/main`.
>
> **La regla:**
> - `docs/CHANGELOG.md` → **de Joel.** Solo se toca en ramas destinadas a un PR suyo, como parte de la contribución.
> - `CHANGELOG-SCR.md` (este) → **nuestro.** Todo lo que es solo de SCR y nunca sale del fork.
>
> Lo mismo aplica al resto de sus docs: una feature **genérica** documenta en los docs de él (va en el PR); una feature **solo nuestra** se documenta acá.

---

## 2026-07-11 — Sincronización con upstream + fidelidad del fork

Traídos los últimos commits de Joel (`fix(status)` de la página Jobs, docs, CLAUDE.md reescrito + skills). Merge sin conflictos; 391 tests pasan.

- **`server/index.js`:** el commit del resumen había re-alineado 9 líneas existentes (puro espaciado) solo para que las columnas calzaran, convirtiendo una adición de 2 líneas en un diff de 20 contra upstream. Restaurado el espaciado de Joel: ahora la única diferencia son las 2 líneas que montan el router del resumen. Menos conflictos cada vez que él toque ese archivo.
- **Remote `upstream` configurado** (`joeltelling/print-farm-manager`), para poder sincronizar y aportar.

**Divergencia contra upstream tras esto:** 1 línea modificada (`IMAGE_NAME` del workflow, config de nuestro despliegue) + `.gitignore` (2 líneas) + `index.js` (2 líneas) + `server/routes/summary.js` (archivo nuevo). Todo lo demás, idéntico a Joel.

---

## 2026-07-10 — Resumen semanal: caché + timeout

Endurecido `GET /api/summary/weekly`, que antes hacía una llamada **pagada** a Claude en *cada* request y podía quedarse colgado para siempre.

- **Caché en memoria (1 h).** El resumen se guarda y se re-sirve por una hora, así una recarga de página no cuesta nada. `?refresh=1` fuerza regenerar. La respuesta ahora trae `cached` y `generated_at`.
- **Timeout de 30 s.** El `fetch` nativo no trae timeout: si la API de Anthropic se colgaba, el request quedaba colgado. Ahora se corta con `AbortController` y devuelve `504`.

Archivo: `server/routes/summary.js`.

---

## 2026-07-09 — Endpoint de resumen semanal con Claude

Primera feature con IA. `GET /api/summary/weekly` agrega los datos de la semana (trabajos, piezas, horas-máquina, material, fallas, desglose por impresora) con SQL, se los pasa a Claude y devuelve un resumen en lenguaje natural (español chileno).

- Usa `fetch` nativo, **sin el SDK** → cero dependencias nuevas, no se toca el lockfile.
- Modelo `claude-sonnet-5`; la key se lee de `process.env.ANTHROPIC_API_KEY` (fuera de git, en el `.env` de hawaiano).
- Sin la key, devuelve `503` y no rompe nada — la feature queda apagada por defecto.

Archivos: `server/routes/summary.js` (nuevo) + 2 líneas en `server/index.js`.

---

## 2026-07-08 — Fix: nombre de imagen en minúsculas

El build fallaba porque `ghcr.io/bluemanBas/scr` lleva mayúscula y Docker exige minúsculas. En `.github/workflows/docker-publish.yml` se fijó `IMAGE_NAME: bluemanbas/scr` en vez de `${{ github.repository }}`.

Es la **única línea que modificamos** de un archivo de Joel. Es configuración de *nuestro* despliegue y él nunca va a tocar esa línea, así que no genera conflictos.
