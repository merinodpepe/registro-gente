# Registro de Encuentros

Una libreta privada para apuntar a la gente que conoces por la calle, pensada para usarse desde el móvil.
Es una web estática publicada en **GitHub Pages** que usa un **Google Sheet privado** como base de datos.
No hay servidor ni claves secretas en el código.

**Web:** https://merinodpepe.github.io/registro-gente/

---

## Estado del proyecto

| Área | Estado |
|---|---|
| Lectura del Sheet (lista, búsqueda, filtros, orden) | Hecho |
| Añadir, editar y borrar personas | Hecho |
| Login con Google (OAuth) | Hecho. Falta probarlo con la cuenta real y añadirla como usuario de prueba |
| Diseño (Street Life + Photo Art), móvil y escritorio | Hecho |
| Accesibilidad y seguridad de datos (revisión del council) | Hecho |
| Publicado en GitHub Pages | Hecho |
| Funcionamiento sin conexión (cola offline + service worker) | Pendiente |
| Seguimiento ("a quién escribir") | Pendiente |
| Deshacer al borrar, "Guardar y otra" | Pendiente |
| Reducir el permiso de Google a solo este archivo | Pendiente |

> Probado en modo demo con datos inventados (capturas móvil/escritorio y pruebas con Playwright).
> Lo que no se ha podido probar de extremo a extremo es el login real y la escritura en el Sheet, porque necesitan la cuenta de Google del dueño.

---

## Cómo funciona

```
 Navegador (GitHub Pages)                        Google
┌─────────────────────────┐   1. login OAuth   ┌───────────────────┐
│ index.html + app.js     │ ─────────────────► │ Google Identity   │
│ (HTML/CSS/JS, sin build)│ ◄───── token ───── │ Services          │
│                         │                    └───────────────────┘
│                         │   2. Sheets API v4 ┌───────────────────┐
│  token solo en memoria  │ ─────────────────► │ Tu Google Sheet   │
└─────────────────────────┘ ◄──── filas ────── │ (privado)         │
                                               └───────────────────┘
```

1. Al abrir la web, **Entrar con Google** pide un token de acceso (scope `spreadsheets`) con Google Identity Services.
2. Con ese token, el navegador llama **directamente** a la API de Google Sheets. No hay servidor intermedio.
3. El token vive solo en memoria y caduca a la hora. Se renueva en silencio y, si no se puede, la web pide volver a entrar.
4. El Sheet **no se comparte con nadie**. Solo tu cuenta puede leerlo o escribirlo, aunque el código de la web sea público.

### Por qué es seguro tener el código público
- El `client_id` de OAuth es público por diseño. No es el `client_secret`, y la web no usa el secreto.
- El ID del Sheet no da acceso por sí solo: sin tu login, Google devuelve 403.
- La app de Google está en modo **Testing**: solo pueden entrar los usuarios de prueba que añadas.

---

## El Sheet

Pestaña `Hoja 1` (si no existe, usa la primera). Fila 1: título. Fila 3: encabezados. Datos desde la fila 4.

| A | B | C | D | E | F | G | H | I |
|---|---|---|---|---|---|---|---|---|
| ID | Fecha | Nombre | Descripción física | Lugar | Contexto / Conversación | Vibes / Tag | Contacto (IG / Telf) | Notas extra |

- La app **busca la fila cuyo encabezado es `ID`** en la columna A, así que la posición exacta de los encabezados no importa.
- Si la fila de encabezados no tiene `Nombre` en la tercera columna, la app **no escribe nada** para no estropear la hoja.
- Los tags se separan con comas y alimentan los filtros.

---

## Qué hace la web

- **Lista** agrupada por día (Hoy, Ayer…), con tarjetas que se despliegan.
- **Buscar** en todos los campos, sin distinguir tildes, con el texto resaltado.
- **Filtrar** por tag, "con contacto" o "sin contacto". **Ordenar** por fecha o nombre.
- **Alta rápida:** basta un nombre *o* una descripción física. Contacto, lugar y contexto van arriba. Fecha, tags y notas están en "Más detalles".
- **Editar y borrar** (con confirmación).
- **Contacto con un toque:** `@usuario` abre Instagram, un teléfono ofrece Llamar y WhatsApp.
- **Exportar a CSV** desde el menú.
- Pide confirmación antes de descartar un formulario a medias.

### Protecciones al escribir en el Sheet
- El texto que empieza por `=`, `+`, `-` o `@` se guarda como texto, no como fórmula. Tampoco se pierden los ceros iniciales de los teléfonos.
- Las altas usan `append` (se añaden al final), así que no pisan filas existentes.
- Antes de editar o borrar se comprueba que la fila sigue siendo la misma (ID y nombre). Si cambió, recarga y avisa.
- No se guardan datos personales en el navegador (sin caché local).
- El CSV exportado también neutraliza fórmulas.

---

## Archivos

| Archivo | Para qué sirve |
|---|---|
| `index.html` | Estructura de la página, formulario y diálogos |
| `styles.css` | Todo el diseño (tema oscuro Street Life) |
| `app.js` | Lógica: login, llamadas a la Sheets API, render, formulario |
| `config.js` | `CLIENT_ID` de OAuth, pestaña por defecto e `SHEET_ID` |
| `manifest.webmanifest` | Datos para instalarla como app en el móvil |
| `assets/` | Imágenes y fuentes del diseño, más `CREDITS.md` con licencias |
| `.gitignore` | Evita subir credenciales, hojas de cálculo reales, plantillas y zips |

No se sube nunca: `client_secret*.json`, `Token*.txt`, `*.xlsx`, `*.csv`, la carpeta de plantillas ni los zips.

---

## El diseño

Basado en dos plantillas del repositorio [Website-Templates](https://github.com/learning-zone/website-templates) (MIT):

- **Street Life** (Callum Rimmer, iFrame): cabecera de hormigón, fondo de asfalto, acento amarillo, título en dos tonos, columnas lateral y principal, y las miniaturas con marco blanco de foto.
- **Photo Art:** la fuente manuscrita *Jenna Sue* para los títulos de día, la fuente *News Cycle* para el texto y los colores cian y lima.

Cómo se adaptó:
- Las miniaturas son los **avatares**: la inicial de cada persona dentro de un marco de foto.
- La columna izquierda de la plantilla es el **resumen, el buscador y los filtros**. En móvil se apila encima de la lista.
- Solo se copiaron los recursos pequeños (228 KB): 2 imágenes, 2 iconos y 2 fuentes con sus licencias.
- Street Life pide mantener un enlace de crédito. Está en el pie de la página.

---

## Puesta en marcha (por si hay que repetirlo)

### 1. Google Cloud (una vez)
1. Crear un proyecto y activar **Google Sheets API**.
2. En **Google Auth Platform**: tipo *Externo*, estado *Testing*, y añadir tu email como **usuario de prueba**.
3. Crear un cliente OAuth de tipo *Aplicación web* con estos **orígenes autorizados de JavaScript**:
   - `https://merinodpepe.github.io`
   - `http://localhost:8000`
4. Copiar el **ID de cliente** en `config.js`.

### 2. El Sheet
1. Subir el Excel a Google Sheets (*Guardar como Hoja de cálculo de Google*).
2. Poner su ID en `config.js` (`SHEET_ID`). Es el texto de la URL entre `/d/` y `/edit`. Si lo dejas vacío, la web lo pide la primera vez.

### 3. Publicar
El repositorio ya está en GitHub con **Pages** activo sobre la rama `main`. Cada `git push` actualiza la web en uno o dos minutos.

### Desarrollo local
```bash
python3 -m http.server 8000
```
- http://localhost:8000 → la web real (pide login).
- http://localhost:8000/?demo → **modo demo**: datos inventados en memoria, sin login ni Sheet. Solo funciona en localhost y sirve para probar la interfaz.

---

## Limitaciones conocidas
- En modo Testing, Google cierra la sesión a los 7 días y hay que volver a entrar.
- Sin conexión no se puede guardar (todavía no hay cola offline).
- El permiso que se pide (`spreadsheets`) cubre todas las hojas de la cuenta. Reducirlo a un solo archivo requiere un selector de archivos de Google.
- Si dos dispositivos añaden a la vez, los IDs podrían coincidir. Se lee antes de calcularlo, pero no hay bloqueo.
- Si cambias el orden de las columnas del Sheet, la app lo detecta y se niega a escribir.

## Ideas para más adelante
1. **Cola offline + instalable como app** (service worker): apuntar sin cobertura y subirlo al volver.
2. **Seguimiento:** sección "pendientes de escribir" y botón para marcar a quién ya escribiste.
3. **"Deshacer"** tras borrar y botón **"Guardar y otra"**.
4. Detección de duplicados al teclear un contacto que ya tienes.
5. Permiso mínimo de Google (solo este archivo).

---

## Privacidad
Este repositorio es público, pero **los datos de las personas no están en él**: viven en tu Google Sheet privado y solo se leen en tu navegador tras iniciar sesión. Cuida que el Sheet esté compartido como *Restringido*.
