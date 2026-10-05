# Prototipo S0: identidad de Claude Code Desktop

Estado: preparado, **no instalado**. Instalarlo cambia la configuración de Claude Code y abre chats de prueba, así que necesita la autorización explícita de Jaime antes de ejecutar los pasos de la sección 3.

## 1. Qué comprueba

El gate S0 del plan ([INICIO_BIDIRECCIONAL.md](INICIO_BIDIRECCIONAL.md)) exige demostrar, con chats reales de Claude Code Desktop, que el puente sabe qué conversación le llama sin fiarse de IDs que escriba el modelo.

El prototipo instala un plugin mínimo de Claude con:

- un servidor MCP (`cc_cdx_bridge`) con una sola herramienta de lectura, `caller_status`. No envía mensajes ni registra sockets;
- tres hooks de tipo command (`SessionStart`, `UserPromptSubmit`, `SessionEnd`), que anotan qué sesión dice el host que corre en cada proceso.

Mide:

1. si el servidor MCP del plugin es descendiente del proceso engine de su chat (`ancestorDepths`). Si cuelga de `Claude.app` o de un proceso compartido, `caller_status` responde `caller_unavailable` y la vía de ascendencia queda descartada;
2. si dos chats nuevos quedan distinguidos (`distinctSessions`, `distinctEngines`);
3. qué claves trae `_meta` en las llamadas MCP de Claude (`metaKeys`, solo nombres);
4. la secuencia real de hooks frente al arranque del MCP (`timeline`), incluido `compact`/`clear` si se prueban;
5. si el registro nativo (`~/.claude/sessions/<pid>.json`) coincide con el `session_id` que el host entrega al hook (`registryMatches`).

Medición previa sin instalar nada (2026-10-05, solo lectura):

- **Un engine por chat.** Cada chat Desktop tiene su propio proceso engine (`…/claude-code/<versión>/…/claude`), con su propio `sessions/<pid>.json` (`entrypoint: "claude-desktop"`, `procStart` en UTC igual a `ps`).
- **Identificación desde un descendiente.** El servidor empaquetado, lanzado desde un proceso descendiente de este chat, identificó correctamente la sesión (`claude_process_ancestry`).
- **Límite que esto deja.** Cualquier proceso que el propio chat lance (por ejemplo, su herramienta Bash) actúa como ese chat. Es la frontera de mismo UID y misma sesión ya declarada en el plan; no permite hacerse pasar por otro chat.
- **Pendiente.** Hoy ningún engine tiene hijos MCP stdio, así que el punto 1 solo se verifica instalando el plugin.

## 2. Qué cambia la instalación

Todo con scope `local` del proyecto donde se abran los chats de prueba (`/Users/jaimebernal/Desktop/cc-cdx-bridge`):

| Cambio | Dónde | Cómo se retira |
| --- | --- | --- |
| Marketplace local `cc-cdx-bridge-local` declarado | `<proyecto>/.claude/settings.local.json` | `claude plugin marketplace remove cc-cdx-bridge-local` |
| Plugin `cc-cdx-bridge@cc-cdx-bridge-local` habilitado | `<proyecto>/.claude/settings.local.json` | `claude plugin uninstall … --scope local` |
| Registros del plugin y del marketplace | `~/.claude/plugins/` (estado del gestor de plugins) | los dos comandos anteriores |
| Estado del prototipo 0.8.1 (`claude-callers/`, `claude-correlations/`, `claude-spike/*.jsonl`) | `~/.claude/plugins/data/<id>/state/` (0700/0600) | `uninstall` lo borra salvo `--keep-data` |
| Dos chats de prueba | Claude Desktop | archivarlos solo con autorización de Jaime |

No cambia:

- `~/.claude/settings.json`, permisos, `CLAUDE.md` ni `AGENTS.md`;
- el registro nativo de sesiones de Claude ni sus sockets;
- el plugin Codex ni su estado (`~/.codex/plugin-state/claude-uds-bridge`). El prototipo 0.8.1 instalado usó su propio directorio de datos.

**Después de S0:** el paquete del worktree ya no fija `CC_CDX_STATE_DIR`. El servidor y el hook usan por defecto el estado compartido del bridge (`$CODEX_HOME/plugin-state/claude-uds-bridge`, normalmente `~/.codex/…`), porque Desktop da directorios `CLAUDE_PLUGIN_DATA` distintos a los chats nuevos y a los recargados. `CC_CDX_STATE_DIR` queda solo como anulación explícita para ensayos aislados. Una actualización a esa versión escribe `claude-callers/`, `claude-correlations/` y `claude-spike/` en el estado compartido.

El marketplace local apunta al worktree `/Users/jaimebernal/Desktop/cc-cdx-bridge-claude-bidirectional/plugins/cc-cdx-bridge-claude`. Como el manifiesto fija `version`, la instalación **copia** el plugin a `~/.claude/plugins/cache/cc-cdx-bridge-local/cc-cdx-bridge/<versión>/`. Los cambios posteriores del worktree no llegan a los chats hasta reinstalar o actualizar el plugin.

Instalación real (2026-10-05 21:24 UTC, autorizada por Jaime en el chat de Claude):
- `.claude/settings.local.json` no existía. Ahora contiene `extraKnownMarketplaces.cc-cdx-bridge-local` y `enabledPlugins["cc-cdx-bridge@cc-cdx-bridge-local"]`. Está excluido por el ignore global de Git (`~/.config/git/ignore`).
- `~/.claude/plugins/installed_plugins.json` tiene una entrada nueva con scope `local` y `projectPath` del proyecto. `~/.claude/plugins/known_marketplaces.json` tiene la entrada `cc-cdx-bridge-local`. Las copias previas están en `/tmp/ccdx-installed_plugins.before.json` y `/tmp/ccdx-known_marketplaces.before.json`.
- La caché del plugin está en la ruta indicada arriba; su bundle es idéntico al del worktree.

## 3. Pasos (solo con autorización)

Antes de instalar:

```bash
cd /Users/jaimebernal/Desktop/cc-cdx-bridge-claude-bidirectional/plugins/claude-uds-bridge && bun scripts/build-claude-plugin.ts && bun test test/claude-caller.test.ts test/claude-plugin.test.ts
```

```bash
claude plugin validate /Users/jaimebernal/Desktop/cc-cdx-bridge-claude-bidirectional/plugins/cc-cdx-bridge-claude/.claude-plugin/plugin.json
```

Guardar el estado previo para poder comparar:

```bash
cd /Users/jaimebernal/Desktop/cc-cdx-bridge && cp .claude/settings.local.json /tmp/ccdx-settings.local.before.json 2>/dev/null || echo "no había settings.local.json"
```

Instalar con scope local:

```bash
cd /Users/jaimebernal/Desktop/cc-cdx-bridge && claude plugin marketplace add /Users/jaimebernal/Desktop/cc-cdx-bridge-claude-bidirectional/plugins/cc-cdx-bridge-claude --scope local
```

```bash
cd /Users/jaimebernal/Desktop/cc-cdx-bridge && claude plugin install cc-cdx-bridge@cc-cdx-bridge-local --scope local
```

Comprobar que Git no ve cambios versionados nuevos. `settings.local.json` no debe añadirse al repo:

```bash
cd /Users/jaimebernal/Desktop/cc-cdx-bridge && git status --short
```

En Claude Code Desktop:

1. Abrir un chat **nuevo** A en `cc-cdx-bridge`, local y sin worktree. Primer mensaje: «Llama a caller_status y muéstrame el resultado».
2. Abrir un chat **nuevo** B en el mismo proyecto y repetir.
3. En A, si la UI lo permite, compactar (`compact`) y volver a llamar a `caller_status`.
4. Cerrar o terminar B (SessionEnd) y, desde A, volver a llamar a `caller_status`.

Informe, antes de desinstalar, porque `uninstall` borra el directorio de datos:

```bash
cd /Users/jaimebernal/Desktop/cc-cdx-bridge-claude-bidirectional/plugins/claude-uds-bridge && bun scripts/claude-identity-spike.ts
```

## Resultado real (2026-10-05, 21:27 UTC)

Jaime abrió dos chats nuevos de Claude Code Desktop en `cc-cdx-bridge` y en cada uno se llamó a `caller_status`. El informe dio **`gate: "pass"`**:

- **Sesiones distinguidas:** dos sesiones (`4d6dfff6…`, `6e488c12…`) y dos engines (2295, 2573), `entrypoint: claude-desktop`, ambas vinculadas con `claude_process_ancestry+hook`.
- **Servidor hijo directo del engine:** el servidor MCP del plugin (`bun …/cache/…/dist/claude-server.js`) es **hijo directo** del engine de su chat (`ancestorDepths: [0]`, `launcherOnly`). Recibe `CLAUDE_PLUGIN_ROOT` apuntando a la caché instalada; `run-bun.sh` hace `exec`.
- **Metadata MCP:** `_meta` de Claude trae solo `claudecode/toolUseId` y `progressToken`. Ningún id de sesión, así que la identidad depende de la ascendencia.
- **Secuencia:** `server_start` → `SessionStart(startup)` unos 3 ms después, con `registryMatches: true` → `UserPromptSubmit` → `caller_status`. El registro nativo ya coincide en el arranque. El modelo no llega en `SessionStart` (`model: null`).
- **Recuento de turnos (`priorUserTurns`):** en el primer prompt fue `null`, porque el host aún no había escrito el transcript. Corregido: un `<session_id>.jsonl` inexistente dentro de una carpeta existente de `~/.claude/projects` cuenta como 0 turnos previos (test incluido). El umbral de S4 se queda en 0.
- **Directorio de datos:** el plugin tiene **dos** directorios de datos distintos. Los chats que lanza Desktop usan `~/.claude/plugins/data/cc-cdx-bridge-inline/`. El chat ya abierto que recargó plugins usa `…/cc-cdx-bridge-cc-cdx-bridge-local/` y cargó el plugin **desde el worktree, en su sitio**, no desde la caché. Por eso el estado compartido de producción no puede depender de `CLAUDE_PLUGIN_DATA`.

Sin probar todavía: `compact`/`clear` y `SessionEnd` en Desktop real.

## 4. Criterio del gate

`gate: "pass"` exige al menos dos sesiones y dos engines distintos vinculados por `caller_status` y ningún `caller_unavailable`. Solo cuentan los servidores que lanzó el host como plugin: `hostLaunch.pluginRootEnv` (Claude exporta `CLAUDE_PLUGIN_ROOT` a los MCP del plugin, no a la herramienta Bash) y `hostLaunch.launcherOnly` (entre el servidor y el engine solo hay `sh`/`bun`). Una copia lanzada desde el shell de un chat también desciende del engine y no prueba nada; aparece en `ignoredNotHostLaunched`. Además hay que revisar a mano:

- `ancestorDepths`: `0` significa que el MCP es hijo directo del engine. Un valor >0 se acepta si los intermedios son el lanzador (`/bin/sh` → `bun`);
- `registryMatches: true` en los hooks de `startup`;
- tras `compact`/`clear`, una generación nueva o `caller_transition` transitorio, y nunca la sesión anterior;
- tras `SessionEnd`, el chat terminado no puede seguir autenticándose;
- `priorUserTurnsSeen`: el número que da el hook en el primer mensaje de un chat nuevo. Si es `1` (el mensaje actual ya está en el transcript cuando corre el hook), la vinculación automática de S4 debe usar `maxPriorUserTurns: 1`. Si es `0`, se mantiene el valor por defecto.

Límites de los recibos de correlación:
- el hook solo emite un recibo si el registro nativo coincide con el `session_id` del host;
- el recuento de turnos solo se acepta para transcripts dentro de `~/.claude/projects`;
- un hook lanzado a mano desde el propio chat puede afectar solo a ese chat, y un chat anterior a la autorización nunca se vincula, porque `startedAt` sale del registro.

Si el MCP no es descendiente del engine, el resultado es `not_met`: se documenta y se pasa al plan B (correlación por hook más canal), sin forzar la ascendencia.

## 5. Retirada

```bash
cd /Users/jaimebernal/Desktop/cc-cdx-bridge && claude plugin uninstall cc-cdx-bridge@cc-cdx-bridge-local --scope local
```

```bash
cd /Users/jaimebernal/Desktop/cc-cdx-bridge && claude plugin marketplace remove cc-cdx-bridge-local
```

```bash
cd /Users/jaimebernal/Desktop/cc-cdx-bridge && diff /tmp/ccdx-settings.local.before.json .claude/settings.local.json
```

Si antes no existía `settings.local.json` y ahora queda vacío o solo con claves del prototipo, borrarlo. Los chats de prueba se archivan solo con autorización de Jaime.

## 6. Privacidad

- **Hooks.** Ni el hook ni el servidor escriben nada en stdout del hook, porque se añadiría al contexto del modelo, y no guardan prompts ni transcript. `UserPromptSubmit` solo busca `CCDX-CORR-<uuid>`. Si lo encuentra, guarda una vez el id, la sesión, el proceso y el número de turnos previos de usuario.
- **Servidor.** `caller_status` registra los nombres de las claves de `_meta`, no sus valores; de los uuid de sesión solo comprueba si coinciden.
- **Ficheros.** Todo queda en ficheros 0600 dentro de un directorio 0700. Los tests lo comprueban con un prompt señuelo.
