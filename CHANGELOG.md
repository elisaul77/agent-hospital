# Changelog

Formato: [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/). Versiones con [SemVer](https://semver.org/lang/es/).

## [0.2.0] - pendiente de publicación

### Añadido

- Observación de sesiones y subagentes de Codex junto con los de Claude Code, a partir de transcripciones locales
  montadas en solo lectura. Los identificadores de sesión separan ambos programas.
- Vista enfocada para sesiones ajenas a subagent-pool: muestra las salas pertinentes a la actividad observada;
  el hospital completo se reserva para sesiones con confirmación estructurada de subagent-pool.
- Pruebas de clasificación, parentesco, aislamiento de sesiones y privacidad de eventos.
- Asociación exacta del expediente de Codex mediante la cabecera `Hospital session`, para evitar activar el flujo
  completo con un expediente de otra sesión.

### Cambiado

- El modo live admite `~/.codex/sessions` mediante `compose.live.yml`; el modo demo mantiene datos sintéticos.

## [0.1.0] - 2026-10-18

Primera versión pública. Resume las fases 1 a 5b1 del plan.

### Añadido

- **Fase 1: visor en Docker, modo demo.** Servidor Node 22 sin dependencias, escena sintética y determinista,
  salas del hospital en Canvas 2D y `docker-compose.yml` con el puerto en `127.0.0.1:8700`.
- **Fase 2: ingesta en vivo.** Lectura en solo lectura de `~/.claude/projects/*.jsonl`, normalización de eventos
  y flujo SSE (`/events`) con instantáneas y deltas.
- **Fase 3: herramientas y avisos.** Cada herramienta se dibuja como equipo de la sala (lupa, desfibrilador, etc.),
  máquina de estados por expediente y puerta de avisos (`fixed`, `must_fix`, `acceptable`, `held`, `unruled`).
  Fase 3b: fusión del rediseño visual de referencia (`design/codex-astra/`).
- **Fase 4: tubos y consejo.** Cápsulas de `SendMessage` por tubos neumáticos, Consejo con cuatro sillas, pool de
  especialistas, Archivo del caso (expedientes `plans/*-state.md` en `HOSPITAL_CASE_DIRS`), sala de Dirección y
  campana de escalado.
- **Fase 4b: fases como pacientes.** Cada fase del plan (`## Phase N`) es un paciente; el progreso se toma del
  expediente y de las transcripciones, con el máximo de ambos.
- **Fase 5a: salida y chips.** Los agentes terminados salen del mapa; chips por expediente; zoom ajustado a enteros;
  Conductor inactivo sale tras `HOSPITAL_CONDUCTOR_IDLE_MIN` minutos.
- **Fase 5b1: visor de solo lectura del archivo.** Lista de expedientes con ids opacos, pestañas Estado, Plan,
  Decisiones/Debate/Brief de cada consejo y Capturas (`plans/shots/*.png`). Guardia de Host
  (`HOSPITAL_ALLOWED_HOSTS`, respuesta `421`) y de Origen (`403` en `/api/*`). Redacción best effort de secretos con
  formato reconocible.
- Pruebas: 321 con `node --test` (sin dependencias de desarrollo), también dentro de Docker (`--target test`).
- Documentación: `README.md`, `docs/design/` (plan y decisiones de los consejos 4b, 5b1 y 5c, con rutas personales
  sustituidas) y capturas en modo demo (`docs/screenshots/`).

### Seguridad

- Montajes de transcripciones y expedientes en solo lectura (`:ro`); la aplicación no escribe en ningún volumen.
- El archivo nunca acepta rutas del navegador: ids opacos y tipos fijos. Los symlinks fuera de `plans/` se rechazan.

### Conocido

- La fase 5c (columna de actividad, consejo en dos pasos, bind de WireGuard) está planificada y no construida.
- La redacción marca como secreto asignaciones como `api_key = value`; se corregirá en 5c.
- Probado solo en Linux.
