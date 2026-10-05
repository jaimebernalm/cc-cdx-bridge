# Fase 6 — Rutinas ampliadas y preparación de cambios coordinados

## Estado y continuidad

Rama `feature/phase-6-coordinated-work`, creada desde `d8cad65` de fase 5, aún sin fusionar. No fusionar ni publicar automáticamente las fases. Fase 5 tiene un Claude temporal pendiente de archivado al desbloquear el Mac; esa limpieza no cambia el alcance de fase 6.

El usuario pidió planificar, explorar, implementar y corregir durante las pruebas. Este documento es el punto de recuperación de contexto. Revisar `git status`, esta lista y los logs privados antes de continuar; conservar cambios ajenos. No crear nuevos chats ni cambiar permisos para conseguir pruebas. No sustituir modelos Desktop por modelos CLI.

## Decisiones de exploración

1. Las rutinas son orientación intelectual, no una máquina de rondas. Ampliar el motor actual, mantener free por defecto, análisis nuevos/existentes/mixtos, desacuerdos y cierre parcial.
2. El transporte actual fija también el diff del proyecto: escribir rompe la siguiente revalidación. Solo un contrato de implementación explícito permite variar el árbol de trabajo; se mantienen sesión/proceso/carpeta/repo/HEAD/base fijados. Un run ordinario conserva la comprobación estricta anterior.
3. Una lista de archivos es un acuerdo y un detector de desviaciones, no un bloqueo del editor. Worktrees Git distintos aíslan los archivos, no los permisos de ejecución ni el acceso entre agentes. La UI y las exportaciones deben decirlo.
4. Registrar worktrees ya creados mediante las herramientas normales de los agentes. No mover silenciosamente chats ni crear sesiones sustitutas. No introducir un ejecutor de comandos arbitrarios dentro del MCP: los modelos ejecutan las pruebas con sus herramientas y permisos; el núcleo conserva recibos declarados, sin presentarlos como ejecución verificada.
5. Preparar integración con un índice Git temporal contra la base común. Aplicar allí los parches de ambos workspaces, detectar conflictos y producir un parche combinado. No modificar el índice/checkout real, HEAD, ramas, remotos, ni hacer commit/merge/push/deploy. La aplicación posterior usa herramientas normales dentro del alcance humano.
6. El candidato es una versión inmutable: hash de contenido, contexto, base, workspaces, reparto y parches. Revisar esa versión, no una descripción suelta. Cualquier cambio posterior exige una nueva captura y nuevos recibos/revisiones.

## Contrato y workflow

### Orientaciones

Añadir `diagnose`, `architecture`, `product`, `test_design`, `compare`, `implement` a `free/research/review`. El catálogo central incluye títulos/descripciones para UI y guía para modelos. Elegir implement sin contrato sirve para planificar; no habilita cambios ni altera permisos.

### Contrato de implementación opt-in

Preparación opcional `implementation`:

- `strategy`: `files` o `worktrees`.
- Dos workspaces por proveedor (`codex`, `claude`): carpeta Git real y rutas relativas permitidas (archivo exacto o subárbol terminado en `/`).
- Base común congelada al HEAD limpio de los workspaces. Mismo repositorio Git; ningún root anidado/symlink como sustituto de otro worktree.
- En files, mismo checkout y ámbitos disjuntos. En worktrees, checkouts realmente distintos; los ámbitos pueden solaparse y la integración deberá detectar conflictos.
- `requiredChecks`: nombres de comprobaciones relevantes que deberán tener recibo aprobado para la versión exacta.
- Validación de rutas: no absolutas, `..`, `.git`, NUL, backslash ambiguo ni ámbitos vacíos. Capturas rechazan symlinks/submódulos y modificaciones fuera de alcance; límites explícitos de tamaño.

No se conceden permisos. Los agentes escriben con sus herramientas habituales. El núcleo no puede demostrar qué modelo escribió un archivo de un checkout compartido; atribuirlo al workspace asignado y señalar ese límite.

### Secuencia de uso

1. Elegir conversaciones y objetivo; análisis previos opcionales.
2. Acordar reparto. Si se eligen worktrees, crearlos con las herramientas normales y registrar sus carpetas reales; no recrearlos durante una recuperación.
3. Preparar/start con contrato y coordinación estructurada. Compartir al par el contrato exacto y sus carpetas. Mientras implementan, los agentes pueden discutir libremente dentro del presupuesto.
4. Codex asigna tarea local de síntesis y captura el candidato. El núcleo registra un resultado versionado propio con manifiesto y parches comprobables; no inventa autoría Claude.
5. Ejecutar pruebas relevantes en los workspaces con las herramientas del agente. Registrar nombre/comando/salida/resumen para candidato exacto, etiquetado como declaración.
6. Pedir revisión Claude del resultId/version exactos. El envío añade el material capturado. Revisiones antiguas, auto-revisión y de otro contexto no cumplen el requisito del otro agente.
7. Inspeccionar preparación: recapturar en lectura, comparar hash, verificar checks declarados, revisión del otro agente vigente y aceptada, y preparar integración en índice temporal. Distinguir falta de evidencia, cambio concurrente y conflicto real.
8. Solo mostrar `ready_to_integrate` si se cumplen esas condiciones técnicas. Significa candidato preparable con recibos/revisión declarados; no verifica verdad de los tests ni consenso. `revise/disagree` conserva objeciones y bloquea esa señal; no impide terminar con salida parcial.
9. Exportar parche de preparación solo tras revalidación actual. Aplicar/commit/publicar permanece separado y requiere el alcance humano correspondiente. Cerrar el run y conservar historial.

## Implementación por módulos

- `routines.ts`: catálogo y guías ampliados.
- `implementation.ts`: esquemas, validación Git/rutas, capturas acotadas, versiones/recibos/operaciones persistentes y preview de integración sin tocar el checkout.
- `runs.ts`: instalar tablas aditivas, incluir contrato en idempotencia, capturar resultado atómico, guardas de estado/lease/contexto, inspección y exportación.
- `collaboration.ts`: exigir capacidad nueva, revalidar identidad fija permitiendo solo dirty cuando hay contrato; incluir contrato y diff capturado en tareas.
- `server.ts`: preparación opt-in y herramienta de captura/recibos/inspección, ligada al caller real.
- `panel-commands.ts` / `panel.ts`: mismo motor, acciones humanas durables, preflight del contrato y exportación privada revalidada.
- `ui/src/App.tsx`: catálogo completo, configuración explícita de reparto/workspaces/checks, ficha de implementación, botones de inspección mediante chat y descarga de parche. Mantener componentes/estética shadcn existentes; el MCP shadcn no está disponible en esta sesión y no se simula su uso.
- Capacidades/manifiestos/guía: candidata 0.8.0; receptores antiguos no habilitan implementación. No asumir que actualizar cache recarga procesos vivos.

## Pruebas necesarias

- Cada nueva orientación pasa esquema, guide, MCP y panel; unknown no se acepta; no se impone escritura por seleccionar una guía.
- Contrato opt-in, duplicación/idempotencia, otro caller, cambio de contrato, carpetas distintas, base diferente, dirty inicial, solapamiento de archivos, rutas peligrosas y symlinks.
- Git real en temporales: archivos nuevos/editados/borrados y modos; snapshot inmutable, cambios posteriores incluso en archivos nuevos, límites de captura.
- Transporte: un run ordinario rechaza cambios; uno de implementación sigue enviando tras un cambio autorizado, pero no tras cambio de HEAD/proceso/root.
- Worktrees reales: distintos árboles, misma base, archivos físicamente separados; integración limpia combina ambos; conflicto conserva trabajo y no cambia índice/HEAD/checkouts.
- Readiness: faltan checks/review, recibo fallido, auto-revisión, revisión vieja/otro contexto, cambio después de revisar y contexto nuevo invalidan preparación. Nada de consenso certificado.
- Replay y pausa/cancelación/lease: ninguna operación duplica versiones ni avanza fuera de estado autorizado. Un fallo de preparación no modifica el proyecto.
- UI por Computer Use: catálogo, contrato, nombres exactos, limitaciones de aislamiento, estado de candidato/recibos/revisiones/conflictos y parche. Los fixtures de IPC no se presentan como modelos reales.
- Tipos, build, suite fuente, suite bundles y compatibilidad de instalación. No ampliar/repetir sin cambio, fallo o duda concreta.

## Checklist

- [x] Exploración y plan persistente; rama propia sin prefijo codex.
- [x] Catálogo/guías y pruebas.
- [x] Contrato y persistencia; capturas Git reales.
- [x] Revalidación de transporte, MCP y acciones del panel.
- [x] Candidato, checks declarados y revisión exacta.
- [x] Preview Git seguro, conflictos y parche revalidado.
- [x] UI utilizable y comprobación visual.
- [x] Versionado/documentación y suites fuente/bundle.
- [x] Evidencia final y límites: motores reales frente a fixtures; actualización de procesos vivos; ausencia de publicación automática.

Logs/transcriptos bajo `.local/phase6/`, fuera de Git. No copiar tokens, IDs privados ni texto libre de modelos al informe público. Actualizar aquí fallos, decisiones y pasos pendientes al encontrarlos.

## Resultados de implementación y correcciones

- Catálogo único de nueve usos consumido por UI/API/MCP. Continúan new/existing/mixto y free por defecto; implement sin contrato sigue siendo planificación.
- Se unificó `sameScopedSnapshot` para envío y receptor. La primera prueba completa detectó que el receptor antiguo bloqueaba una revisión tras un cambio autorizado; el test durable cubre ahora recepción, revisión y exportación con árbol modificado.
- Se corregieron enlaces rotos (lstat aunque el destino no exista), borrados de symlinks/gitlinks, renames que podían ocultar un origen fuera de alcance y pathspecs interpretados como glob: el diff usa rutas literales y no-renames. Se conservan HEAD, índice real y ambos worktrees incluso con conflicto.
- Captura vuelve a verificar todos los workspaces, incluido device/inode/repositorio/base; inspección revalida disco/contexto/candidato/revisiones/recibos tras el preview. Los UUID/versiones de resultados capturados no pueden sustituirse mediante un informe ajeno a captura.
- Se arregló el aviso UI «undefined» para acciones de implementación y el ajuste de cuatro pestañas en una ventana estrecha. La prueba a 390 px informó ancho de documento igual al viewport, sin desbordamiento horizontal; después se restableció el viewport habitual.
- La primera prueba visual recorrió preflight → create → capture → recibo declarado → revisión sintética por IPC → inspección → descarga. Git y núcleo reales; ambas identidades/modelos de ese ensayo son fixtures. Captura privada `.local/phase6/ui-integration.png`; parche descargado solo en el ámbito de prueba. El ensayo nativo posterior se distingue a continuación.
- 151 pruebas / 1195 aserciones por suite fuente y bundle aprobadas, incluidos 15 casos nuevos de fase 6. Tipos backend/UI y build aprobados. El test antiguo que contaba herramientas se actualizó de 13 a 15 por las dos herramientas nuevas.
- Instalación CLI **aislada**: siete comprobaciones aprobadas, actualización real 0.6.1 → 0.8.0, hashes de archivos/guía/UI, conservación de historial/órdenes/autorización al actualizar/desinstalar/reinstalar y launcher con PATH reducido. No usa auth real, cambia settings de Claude ni crea sesiones de modelos. Log privado `.local/phase6/installation.log`.
- La primera CI de la PR aprobó Linux completo y detectó un timeout de 5 segundos en macOS para el escenario de readiness con varias capturas y previews Git reales. Se acotó ese test a 20 segundos, igual que los otros ensayos Git/IPC largos, sin cambiar aserciones ni límites del producto; se exige una nueva CI del commit corregido.

## Piloto nativo de escritura — 5 de octubre de 2026

- Se actualizó la instalación personal a 0.8.0 y se comprobó la recarga del MCP/receptor con `implementation_v1`, usando los chats Desktop existentes. Se conservaron los ajustes y la autorización recordada del proyecto. El diagnóstico sigue sin observar la política efectiva de Claude ni demostrar confianza de hooks por presencia del receptor.
- Dos worktrees existentes y separados, con base común y ámbito `pilot-phase6/`: Codex implementó el formato de un presupuesto positivo seguro; Claude implementó su parseo. Claude exigió la confirmación humana directa porque su instrucción anterior prohibía editar. Esa confirmación precedió a su edición; el puente no otorgó permisos ni sustituyó el chat.
- Pruebas ejecutadas: Codex 11/0, Claude 8/0 y verificación independiente de esos 8 por Codex. En un tercer worktree se aplicó el parche exacto y se ejecutaron 31/0 pruebas, 74 aserciones: 19 de los archivos capturados y 12 de integración añadidas aparte. Estos últimos tests no forman parte del candidato de cuatro archivos; Claude no afirmó haber ejecutado la integración.
- Claude revisó la versión 1 y señaló tres espacios NBSP invisibles en su test. Tras corregirlos por escapes, la preparación de v1 dejó de ser válida. Se capturó v2 con hash nuevo, inicialmente sin recibos ni revisión, se repitieron las pruebas y Claude revisó esa versión exacta. La revisión de v1 quedó histórica; v2 terminó preparada para integrar y el run se cerró como propuesta, sin consenso certificado.
- El replay de la operación de captura de v1 devolvió la captura guardada y no creó otro candidato. HEAD e índices de los autores y del checkout principal permanecieron idénticos; se conservaron claves durables de las nueve bases privadas y políticas/autorizaciones. Los metadatos de capacidad del receptor se actualizaron a la nueva versión. No hubo commits, publicación ni aplicación del parche al proyecto principal.
- El panel real descargó v1 y v2; sus bytes coincidieron con los parches inspeccionados. Un cambio temporal autorizado en un archivo del piloto hizo rechazar la descarga. Se corrigió que ese rechazo no fuera visible: ahora aparece el motivo y desaparece el indicador de preparado. Se probó tanto el rechazo como la descarga válida después de restaurar los bytes originales. El navegador integrado no guardaba descargas `blob:`; se usa el adjunto HTTP autenticado, con precomprobación y nueva validación en el servidor. No constituye un bloqueo frente a modificaciones entre ambas peticiones.
- La corrección de UI pasó tipos y build y se cargó en el panel instalado. Evidencia, parches, salidas y capturas quedan privados en `.local/phase6/native-preparation/`. El cierre inmutable conserva la nota histórica de que faltaba mejorar el aviso de descarga; esta comprobación posterior documenta la corrección.

## Límites y entrega pendiente

El piloto acredita cooperación con escritura en worktrees separados en este entorno macOS; no demuestra que ambos modelos razonaran o editaran exactamente al mismo tiempo, ni mejora universal frente a un agente. Los fixtures cubren conflictos y límites difíciles de reproducir; no se presentan como modelos reales. El núcleo verifica integridad, alcance y vigencia, pero no ejecuta tests ni valida el rigor del veredicto. CI Linux/macOS de fase 5 no acredita automáticamente el código nuevo de fase 6; la siguiente PR deberá ejecutar su propia CI.

Preparar integración no crea PR, hace merge, commit de resultados de usuario ni publica automáticamente. La PR de esta fase usa `feature/phase-5-pilot-hardening` como base porque fase 5 sigue sin fusionar; su diff aísla fase 6. Después de entregar fase 5, cambiar la base a `main` y comprobar de nuevo el diff y la CI antes de fusionar. Los logs, tokens, transcriptos y screenshots del ensayo permanecen fuera de Git.

La candidata local está instalada y el panel nativo ha sido probado. El usuario ha solicitado preparar y abrir la PR; esa entrega conserva la dependencia de fase 5 y requiere su propia CI. No borrar los worktrees del piloto sin preservar su trabajo y evidencia.
