# Changelog - SCR (fork)

Cambios **propios de SCR** (Fábrica 3D), los que no van al repo original.

> **Por qué existe este archivo.** `docs/CHANGELOG.md` es de Joel (upstream). Tanto él como nosotros agregamos entradas **arriba del todo**, así que editarlo garantiza conflictos en cada `git merge upstream/main`.
>
> **La regla:**
> - `docs/CHANGELOG.md` → **de Joel.** Solo se toca en ramas destinadas a un PR suyo, como parte de la contribución.
> - `CHANGELOG-SCR.md` (este) → **nuestro.** Todo lo que es solo de SCR y nunca sale del fork.
>
> Lo mismo aplica al resto de sus docs: una feature **genérica** documenta en los docs de él (va en el PR); una feature **solo nuestra** se documenta acá.

---

## 2026-07-11 - Decisión: la traducción NO se construye en el fork

Sin código, pero define lo que no vamos a hacer.

Se iba a construir la estructura de i18n acá. Al investigar apareció el [issue #10](https://github.com/joeltelling/print-farm-manager/issues/10) de upstream: **Joel ya aprobó la feature** ("let's make this happen", 4-jul) y la comunidad (cyryllo, seanlw, xhudaman) ya convergió en **react-i18next**, claves `namespace.key` planas y `en.json` como esquema. Hay voluntarios para polaco, francés y noruego, y **cero código escrito**.

**Se descartó el diseño propio** (hecho a mano, sin dependencias, que era lo coherente con las convenciones del repo: 3 dependencias de runtime, cero providers). Llegar con eso contradiría el consenso del hilo y terminaría en un PR rechazado, o sea el trabajo doble que justamente queremos evitar.

**Lo que hacemos:** aportar solo el `es.json` cuando la infraestructura aterrice upstream. Ya se comentó en el #10 ofreciéndolo, y regalando el dato que le va a explotar en la cara a quien haga la extracción: `formatDurationForInput` y `formatMaterialForInput` (`Projects.jsx:9` y `:17`) producen `2h30m` y `45g`, que **no son texto de UI sino formato de datos** que el servidor parsea. Traducirlos rompe la edición de tiempo y material.

**Consecuencia asumida:** la granja sigue en inglés hasta que alguien cablee el i18n. Si en un par de semanas nadie arranca, conviene reevaluar y tomarlo nosotros.

**Ojo para cuando llegue:** la página **G-codes no existe en el repo de Joel**, así que sus textos no van en el PR del `es.json`. Se traducen en un commit aparte, propio del fork.

---

## 2026-07-11 - Página Resumen + arreglo de un bug intermitente que borraba el resumen

El resumen semanal existía **solo como endpoint**: para verlo había que pegarle con `curl`. Ahora hay una página **Summary** (`/summary`) con un botón que lo genera y lo muestra, junto a los números crudos y el desglose por impresora.

**Decisión de diseño: la página no consulta sola al cargar.** Forzar un resumen cuesta plata (llama a Claude), así que es el operador quien decide cuándo pagarlo. El resultado se cachea una hora, y la página muestra si el texto viene de caché y de cuándo es, para que nadie pague una consulta sin querer. El botón **Refresh** es el único que fuerza una llamada nueva.

### El bug que apareció al probarlo

Al verificar la página contra el endpoint real, el resumen volvió **vacío**: `(sin texto)`. La causa: `summary.js` leía `data.content[0].text`, o sea asumía que el texto de Claude está siempre en el **primer** bloque de la respuesta.

No es así. `claude-sonnet-5` **a veces antepone un bloque `thinking`**, y entonces el texto queda en `content[1]`. Comprobado contra la API real: una llamada local devolvió `content[0].type = 'thinking'` y `content[1].type = 'text'`, mientras que producción, con el mismo modelo y a la misma hora, devolvió el texto en `content[0]`.

Por eso era un bug **intermitente**, que es lo peligroso: el resumen funcionaba casi siempre y de vez en cuando salía vacío, sin error, habiendo pagado igual la llamada. Ahora se busca el primer bloque `type === 'text'` en vez de confiar en la posición.

Aprovechando, `summary.js` pasó de **cero tests** a 7 (mockeando `fetch`, nunca el módulo). El de regresión falla sin el arreglo: se verificó con `git stash`.

### Changes

- `client/src/pages/Summary.jsx` (nuevo): página con botón de generar, texto de Claude, tarjetas de estadísticas y tabla por impresora. Panel fijo (no toast) cuando falta la API key, porque es un problema de configuración, no una falla pasajera.
- `client/src/App.jsx`: item de nav **Summary** y ruta `/summary`.
- `server/routes/summary.js`: extraer el primer bloque `text` de la respuesta en vez de `content[0]`.
- `server/tests/summary.test.js` (nuevo): 7 tests. Regresión del bloque `thinking`, 503 sin API key, agregación semanal, caché, `?refresh=1`, 504 por timeout y 502 si Claude falla.

### Desplegado y verificado en producción

En hawaiano, no solo "el deploy pasó": se leyó el código **dentro del contenedor corriendo** (`summary.js:134` trae el `find(b => b.type === 'text')`), se confirmó que el cliente construido incluye la página, que la ruta `/summary` responde 200, y que el endpoint devuelve texto real forzando sin caché.

**Pendiente (cosmético):** la página está en inglés pero Claude escribe en español, así que queda una UI inglesa con un párrafo español adentro. Se resuelve cambiando el system prompt a inglés, o esperando el i18n de upstream (ver la entrada de abajo).

---

## 2026-07-11 - Rama del PR al día con Joel + limpieza de estilo

La rama `gcode-library` (la del futuro PR) estaba **rota y vieja**: 4 tests fallando y basada en un código de Joel de hace varios commits. Como el `build` de su CI solo corre si `test` pasa, así no era presentable.

Se rehízo sobre su `main` actual y quedó **en un solo commit, con 408 tests verdes**. El código de la feature ya era idéntico al de nuestro `main`; lo que le faltaba eran los tests corregidos.

De paso se corrigieron dos cosas que también estaban en nuestro `main`:

- **La doc mentía.** `docs/web-app.md` describía la página G-codes como una **tabla con columnas**, pero terminó siendo una **galería de tarjetas** con miniatura de 200 px. Reescrita para que describa lo que el código realmente hace.
- **Guiones largos.** La regla 3 de `CLAUDE.md` (de Joel) los prohíbe en prosa, comentarios, mensajes de commit y textos de UI nuevos. Se limpiaron solo **las líneas que agregamos nosotros**; las suyas quedaron intactas, como pide su propia regla. Se conservó el `'—'` que usa como símbolo de "sin dato" en la UI, porque es su idioma (ver `Jobs.jsx`, `PrinterDetail.jsx`).

### Cambios

- `docs/web-app.md`: la sección G-codes ahora describe la galería real (tarjetas, miniatura de 200 px, fallback 🖼️), no una tabla.
- `server/routes/gcodes.js`, `server/gcode-thumbnail.js`, `server/db.js`, `server/routes/parts.js`, `server/routes/projects.js`, `client/src/pages/Gcodes.jsx`, `client/src/pages/Projects.jsx`, tests y docs: guiones largos fuera de las líneas propias.
- `CHANGELOG-SCR.md`: mismo criterio de guiones.

---

## 2026-07-11 - Biblioteca de G-codes (nuestra versión, pendiente upstream)

Página **G-codes** nueva: galería con todos los archivos, cada uno **una sola vez**, con buscador, descarga y borrado definitivo.

- **Reuso entre proyectos:** un archivo se adjunta a otra parte **sin re-subirlo y sin duplicarlo en disco** - las filas comparten el mismo `filepath` y el archivo físico solo se borra cuando ya nadie lo referencia.
- **Quitar ≠ borrar:** sacar un G-code de una parte solo lo desvincula; el archivo sigue en la biblioteca aunque no lo use ningún proyecto. El borrado definitivo se hace desde la página G-codes.
- **Miniaturas reales:** se extrae la imagen que el slicer embebe en el archivo (`.bgcode` de Prusa y `.gcode`), **sin agregar dependencias** (`server/gcode-thumbnail.js`).
- **Esquema:** `gcodes.part_id` pasa a ser nulo (un archivo puede vivir en la biblioteca sin parte). Migración puntual al arrancar, mismo patrón que la de `jobs.gcode_id`.

Endpoints: `GET /api/gcodes/library`, `/:id/download`, `/:id/reuse`, `/:id/thumbnail`; `DELETE /:id` (desvincula) y `DELETE /:id/file` (borra de verdad).

> **Ojo - divergencia con Joel.** El "quitar ≠ borrar" cambia el contrato de `DELETE /api/gcodes/:id` (en su código ese endpoint borra el archivo), así que hubo que **adaptar sus tests** a la nueva semántica. Está abierto el [issue #34](https://github.com/joeltelling/print-farm-manager/issues/34) preguntándole qué comportamiento prefiere; si elige el conservador, esta divergencia desaparece. La rama `gcode-library` tiene la versión limpia para el PR.

---

## 2026-07-11 - Sincronización con upstream + fidelidad del fork

Traídos los últimos commits de Joel (`fix(status)` de la página Jobs, docs, CLAUDE.md reescrito + skills). Merge sin conflictos; 391 tests pasan.

- **`server/index.js`:** el commit del resumen había re-alineado 9 líneas existentes (puro espaciado) solo para que las columnas calzaran, convirtiendo una adición de 2 líneas en un diff de 20 contra upstream. Restaurado el espaciado de Joel: ahora la única diferencia son las 2 líneas que montan el router del resumen. Menos conflictos cada vez que él toque ese archivo.
- **Remote `upstream` configurado** (`joeltelling/print-farm-manager`), para poder sincronizar y aportar.

**Divergencia contra upstream tras esto:** 1 línea modificada (`IMAGE_NAME` del workflow, config de nuestro despliegue) + `.gitignore` (2 líneas) + `index.js` (2 líneas) + `server/routes/summary.js` (archivo nuevo). Todo lo demás, idéntico a Joel.

---

## 2026-07-10 - Resumen semanal: caché + timeout

Endurecido `GET /api/summary/weekly`, que antes hacía una llamada **pagada** a Claude en *cada* request y podía quedarse colgado para siempre.

- **Caché en memoria (1 h).** El resumen se guarda y se re-sirve por una hora, así una recarga de página no cuesta nada. `?refresh=1` fuerza regenerar. La respuesta ahora trae `cached` y `generated_at`.
- **Timeout de 30 s.** El `fetch` nativo no trae timeout: si la API de Anthropic se colgaba, el request quedaba colgado. Ahora se corta con `AbortController` y devuelve `504`.

Archivo: `server/routes/summary.js`.

---

## 2026-07-09 - Endpoint de resumen semanal con Claude

Primera feature con IA. `GET /api/summary/weekly` agrega los datos de la semana (trabajos, piezas, horas-máquina, material, fallas, desglose por impresora) con SQL, se los pasa a Claude y devuelve un resumen en lenguaje natural (español chileno).

- Usa `fetch` nativo, **sin el SDK** → cero dependencias nuevas, no se toca el lockfile.
- Modelo `claude-sonnet-5`; la key se lee de `process.env.ANTHROPIC_API_KEY` (fuera de git, en el `.env` de hawaiano).
- Sin la key, devuelve `503` y no rompe nada - la feature queda apagada por defecto.

Archivos: `server/routes/summary.js` (nuevo) + 2 líneas en `server/index.js`.

---

## 2026-07-08 - Fix: nombre de imagen en minúsculas

El build fallaba porque `ghcr.io/bluemanBas/scr` lleva mayúscula y Docker exige minúsculas. En `.github/workflows/docker-publish.yml` se fijó `IMAGE_NAME: bluemanbas/scr` en vez de `${{ github.repository }}`.

Es la **única línea que modificamos** de un archivo de Joel. Es configuración de *nuestro* despliegue y él nunca va a tocar esa línea, así que no genera conflictos.
