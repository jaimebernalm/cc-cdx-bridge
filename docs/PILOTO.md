# Piloto 0.7.0: uso y recuperación

Candidata local en `feature/phase-5-pilot-hardening`, sin release ni fusión; rama publicada para CI. Plan y evidencia: [FASE_5.md](FASE_5.md) y [PILOT_EVIDENCE.json](PILOT_EVIDENCE.json). El reinicio completo de apps y varios ensayos nativos siguen pendientes.

## Cambios

- Las órdenes nuevas guardan estado de wake y dueño de forma atómica. Órdenes antiguas huérfanas se señalan sin replay; la inspección conserva separado el error original.
- El panel reconcilia notificaciones con ACK perdido consultando su `clientId` exacto y proyecto nativo; no las reenvía. Consumir la notificación no prueba que la orden se aplicó.
- El diagnóstico distingue política explícita, autorización por carpeta y versión/capacidades del receptor vivo. Actualizar archivos no sustituye procesos ya abiertos.
- La UI mantiene accesibles los objetivos largos sin desplazar todo el resultado, y distingue cierre sin resultado de una espera activa. Muestra la versión del servicio conectado. Una entrega incierta aparece como incidencia sin indicador de trabajo infinito.
- Verificador con CLI real: actualización desde 0.6.1, hashes, PATH reducido, desinstalación y reinstalación conservando bases privadas.
- Regresiones de reinicios, credenciales antiguas, alias iguales, espacios/Unicode y worktrees.
- Resúmenes compartibles por lista permitida; las exportaciones completas siguen privadas.

## Compatibilidad

| Capa | Comprobación | Límite |
|---|---|---|
| Bun | 1.4.2; launcher con PATH reducido | Otros runtimes no se presuponen |
| Codex Desktop | IPC con `supportsUntrustedAppInput`, stream 11 | Contrato interno; otra versión de stream se bloquea |
| Claude Desktop Code | Protocolo de pares 1; motor 2.1.286 observado | Actualizar CLI no actualiza el motor Desktop; CLI/VS Code no sustituyen al chat elegido |
| Plataforma | macOS local; Linux y macOS en CI de fase 5 | Las pruebas de IPC en CI usan fixtures; no ejecutan las apps Desktop. Windows no implementado |
| Recepción | Política explícita y autorización por carpeta exacta | Otro worktree no hereda; no libera mensajes antiguos ni concede ejecución/edición |
| Modelo | Respuesta correlacionada y evaluación de versión/hash | No certifica verdad, independencia intelectual ni consenso |
| Progreso | Turnos nativos y órdenes humanas durables | No hay supervisor que invente tareas en segundo plano |

## Instalar o actualizar

Desde la carpeta del plugin: `bun run build`. Registrar el checkout con `codex plugin marketplace add /ruta/al/checkout --json` e instalar con `codex plugin add claude-uds-bridge@jaimebernalm --json`.

Los chats abiertos pueden conservar MCP/receptor anteriores. Terminar trabajo pendiente, reabrir Codex y comprobar el diagnóstico. Un receptor activo no demuestra confianza de hooks para un chat nuevo: revisarla en la app.

Para activar un chat existente, usar `attach_current` desde él, o CLI `attach --thread UUID --project /carpeta/exacta`. Verifica proyecto nativo y receptor único, conserva historia y recepción. **Attach reutiliza un receptor vivo; no lo actualiza automáticamente.**

## Recuperación

1. Abrir el panel con su herramienta o CLI. Un servicio nuevo devuelve un enlace privado nuevo; cookies/enlaces anteriores ya no sirven. No publicar su token.
2. Consultar colaboración y diagnóstico. `unknown` y `application_uncertain` no significan «reintentar».
3. Si el historial nativo contiene el identificador exacto de una notificación incierta, el panel puede mostrar «Esperando al agente». Sigue sin acreditar aplicación; sin evidencia conserva la incidencia.
4. Recuperar explícitamente un run cuyo controlador cayó. No reinicia presupuesto/plazo ni reenvía mensajes. Si cambió el participante, cancelar el run antiguo y seleccionar la conversación actual para otro.
5. Una respuesta antigua o de un run cerrado no reactiva trabajo ni valida el contexto vigente.
6. Ante receptor antiguo, terminar trabajo y reabrir el chat. No borrar SQLite, registros ni locks para hacerlo funcionar. Un lock no verificable exige inspeccionar su dueño.
7. Ante recepción retenida, comprobar política explícita y alcance recordado. La recepción efectiva de Claude puede seguir desconocida: `settings.json` no prueba overrides de sesión.

Un fallo del puente no cambia permisos para eludirlo; se puede seguir trabajando normalmente en las apps.

## Desinstalación y datos

Terminar/cancelar colaboraciones, cerrar sus chats/receptores y detener el panel con Ctrl+C. Después ejecutar `codex plugin remove claude-uds-bridge@jaimebernalm --json`. Desinstalar archivos **no detiene procesos ya vivos**. Reabrir la app para comprobar que ya no carga el plugin.

Las bases viven fuera del cache, en `CODEX_HOME/plugin-state/claude-uds-bridge`: conversaciones, runs, órdenes y autorizaciones. El verificador comprueba su conservación al actualizar, desinstalar y reinstalar. Reinstalar permite consultarlas y puede conservar una autorización vigente: revocarla desde el panel antes si no se desea mantenerla. Borrar datos es otra decisión explícita y destructiva; no se hace automáticamente.

## Pruebas reproducibles y evidencia

Desde `plugins/claude-uds-bridge`:

```sh
bun run check
bun run build
bun test
UDS_MCP_TEST_ENTRYPOINT="$PWD/dist/server.js" UDS_HOOK_TEST_ENTRYPOINT="$PWD/dist/hook.js" bun test
bun run verify:installation
```

El verificador usa el CLI real y un home aislado bajo `.local/phase5/`. Requiere el objeto Git del merge de fase 4 (`2341cb6`). No copia autenticación, confía hooks, envía prompts ni edita Claude. Los tests de IPC usan fixtures: no acreditan por sí solos respuestas de modelos Desktop.

Las exportaciones normales contienen texto, rutas e identidades privadas. Preparar una entrada con esta forma y ejecutar `bun run sanitize:pilot --input evidencia-privada.json --output resumen-compartible.json`:

```json
{
  "schemaVersion": 1,
  "version": "0.7.0",
  "platform": "darwin",
  "runtime": "1.4.2",
  "checks": [{"check": "source_suite", "passed": true, "count": 135}],
  "realCases": [{"case": "L01", "outcome": "passed", "version": "0.7.0"}]
}
```

Solo copia categorías definidas en `src/pilot-evidence.ts` y casos L01–L18. Omite campos adicionales y texto libre; rechaza versiones/categorías mal formadas. No atribuir evidencia antigua a 0.7.0: registrar la versión realmente probada y `not_run`/`blocked` cuando corresponda.
