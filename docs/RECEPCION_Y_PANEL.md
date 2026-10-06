# Corrección del inicio y del panel — 2026-10-05

Rama: `fix/collaboration-preflight-live-panel`. El ensayo de UFC terminó tras recordar la autorización de su carpeta (10 mensajes); inicialmente el diálogo MCP devolvió `decline` sin autorización y ambas respuestas fueron denegadas. No atribuir esa respuesta automática a una elección humana.

## Objetivo y alcance

- Comprobar la recepción antes de activar o enviar trabajo, también cuando se inicia desde el panel. Un permiso recordado no vence `hold`/`refuse`, ni cubre otro worktree. No cambiar permisos automáticamente.
- Proporcionar el panel al preparar y abrirlo al iniciar, o antes si hace falta autorizar. En macOS usar el navegador predeterminado; el agente puede mostrar el enlace en el navegador de Codex. Fallar al abrir no impide usar el enlace. No exponer credenciales en exportaciones, logs o el repositorio.
- Refrescar datos sin recargar el documento ni borrar formularios. Aislar fallos de participantes/órdenes frente al detalle; evitar respuestas concurrentes antiguas; mostrar la última actualización y desconexiones; refrescar al volver a la pestaña y tras reconexión SSE.
- Enseñar el flujo en las instrucciones MCP, descripciones de herramientas y skill. Un diagnóstico previo no demuestra la recepción efectiva de Claude: comprobar una respuesta correlacionada breve antes de desarrollar el trabajo. La barrera inicial debe seguir representando análisis, no un ping.

## Implementación

1. Módulo común de preflight: receptor verificado, política explícita, herencia por carpeta exacta y capacidad del receptor, restricciones observadas de Claude. `default` sin herencia se detiene antes de gastar mensajes. Preparar sigue permitido para solicitar autorización; activar y enviar revalidan.
2. MCP devuelve estado y enlace accionables. Si un diálogo devuelve decline/cancel, describe únicamente que no se confirmó y ofrece el panel, sin repetir el diálogo. El panel usa la misma comprobación.
3. Apertura local con opción de no abrir y supresión explícita en fixtures; no abrir ventanas en CI. Enlace profundo a autorización o colaboración exacta.
4. Actualización independiente y serializada, límites de espera HTTP, reconexión, indicador de frescura y botón manual. Respetar selección y contenido editable.

## Validación realizada

- Preflight: default sin grant, grant válido, rechazo/retención explícitos, receptor antiguo, carpeta distinta, revocación después de start, restricción Claude; cero mensajes antes de autorizar.
- Panel/MCP: acceso y CSRF conservados, apertura idempotente y navegación profunda, rechazo del diálogo sin afirmar rechazo humano, preflight del panel bloquea antes del wake.
- Refresco: detalle actualizado aunque falle otra petición, peticiones serializadas, cambio de selección, SSE y vuelta a la pestaña, reconexión y estado obsoleto visible.
- Tipos y build correctos. Suite fuente: 163 pruebas, 0 fallos, 1239 aserciones; suite empaquetada: los mismos resultados. Los casos anteriores están cubiertos por pruebas automatizadas; no todos representan pruebas con modelos reales.
- Navegador con estado aislado: navegación directa al run, aparición de tres versiones de resultado y del cierre sin F5; texto del formulario conservado durante las actualizaciones. Captura privada: `.local/ux/live-refresh.jpg`. El panel antiguo mostró explícitamente que su servicio ya no estaba disponible.
- Verificación aislada de instalación: siete comprobaciones correctas, incluida actualización a 0.8.1 con conservación de historial, comandos y autorización; desinstalación/reinstalación y comparación de archivos. Informe privado: `.local/phase5/installation-1e18bcb1-2105-4ea9-bc02-79ee73fa6aff/result.json`.

## Límites y entrega

Idioma del panel: inglés por defecto y selector English/Español, también disponible antes de conectar. Textos, estados, fechas, título del documento y etiquetas accesibles se adaptan sin remontar formularios ni cambiar argumentos del protocolo. Preferencia local al origen del panel, conservada al recargar; otra dirección local vuelve al inglés. Comprobado en navegador con fixture aislado: arranque inglés, cambio español, conservación del objetivo y persistencia tras recarga; pantalla de autorización y opciones de implementación en inglés. Las aportaciones de los agentes conservan su idioma original.

La comprobación de una respuesta breve es una instrucción del flujo para el agente; el núcleo no certifica que el modelo haya leído o comprendido el mensaje. La apertura automática se probó con un lanzador controlado: despachar una apertura no demuestra que una ventana sea visible. El ensayo de navegador usa IPC de prueba, sin mensajes a modelos reales. La colaboración real de UFC es evidencia previa del usuario, no una nueva prueba con esta versión.

La versión es 0.8.1. Un receptor vivo no se actualiza por regenerar o instalar archivos; los chats existentes deben recargar el plugin para usar los cambios. La conversación de UFC y sus archivos no forman parte de este cambio. La rama queda preparada para revisión, sin crear ni fusionar una PR en esta tarea.
