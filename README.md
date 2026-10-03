# Registro de Encuentros

Web estática (GitHub Pages) que usa un Google Sheet privado como base de datos.
Login con Google (OAuth en el navegador): sin backend y sin secretos en el código.

- Consultar, buscar, filtrar por tag/contacto y ordenar.
- Añadir, editar y borrar (escribe directamente en el Sheet).
- Enlaces rápidos a Instagram / llamada / WhatsApp.
- Exportar a CSV.

Configuración en `config.js`. La primera vez la web pide la URL del Sheet y la guarda solo en tu navegador.

Desarrollo local: `python3 -m http.server 8000` y abrir http://localhost:8000
