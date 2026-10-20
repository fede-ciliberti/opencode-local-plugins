import { Plugin } from "@opencode/plugin"

/**
 * Completa los modelos que llegan por descubrimiento local (`vllm`, `ollama`).
 *
 * El discovery local sólo aporta `id`, `owned_by` y `max_model_len`: OpenCode
 * arma el modelo sin capabilities, sin variantes de razonamiento y con los
 * límites por defecto. Este plugin toma como referencia el mismo modelo base
 * publicado por cualquier otro provider del registro (catálogo models.dev o
 * configuración propia) y le copia:
 *
 *   - los niveles de esfuerzo, re-escritos para el paquete del provider local
 *     (`@opencode/ai/providers/openai-compatible` → `settings.reasoningEffort`),
 *   - `tools: true` cuando el modelo base lo soporta,
 *   - `limit.output` cuando el modelo base declara uno mayor.
 *
 * El contexto lo manda el gateway (`max_model_len`) y nunca se pisa. Así, dar de
 * alta un modelo virtual en el gateway alcanza: no hay que repetir su bloque
 * `models` en `opencode.json`.
 */

const LOCAL_PROVIDERS = ["vllm", "ollama"]

/** Sufijos operativos que separan el nombre de la virtual model del modelo base. */
const SUFFIXES = ["-pool", "-alias", "-vm", "-lb", "-group", "-balance", "-router"]

/** Separadores aceptados entre el id del modelo base y el sufijo operativo. */
const SEPARATOR = /^[-_.:/]/

type Reference = {
  readonly efforts: readonly string[]
  readonly tools: boolean
  readonly output?: number
}

const normalize = (id: string) => id.trim().toLowerCase()

/** Niveles de esfuerzo que declara un modelo de referencia, en orden de aparición. */
function effortsOf(model: { variants?: readonly any[] }): string[] {
  const values: string[] = []
  for (const variant of model.variants ?? []) {
    const effort =
      typeof variant?.settings?.reasoningEffort === "string"
        ? variant.settings.reasoningEffort
        : typeof variant?.body?.reasoning_effort === "string"
          ? variant.body.reasoning_effort
          : undefined
    if (effort && !values.includes(variant.id)) values.push(variant.id)
  }
  return values
}

function stripSuffixes(id: string): string {
  let current = id
  for (const suffix of SUFFIXES) {
    if (current.endsWith(suffix)) current = current.slice(0, -suffix.length)
  }
  return current
}

/**
 * Busca el modelo de referencia para un id descubierto, en orden:
 * exacto → sin sufijo operativo → prefijo más largo cerrado por separador.
 */
function resolve(references: Map<string, Reference>, modelID: string): Reference | undefined {
  const id = normalize(modelID)
  const exact = references.get(id)
  if (exact) return exact

  const bySuffix = references.get(stripSuffixes(id))
  if (bySuffix) return bySuffix

  let best: { key: string; reference: Reference } | undefined
  for (const [key, reference] of references) {
    if (key.length < 8 || !id.startsWith(key)) continue
    const rest = id.slice(key.length)
    if (rest.length > 0 && !SEPARATOR.test(rest)) continue
    if (!best || key.length > best.key.length) best = { key, reference }
  }
  return best?.reference
}

export default Plugin.define({
  id: "local-model-variants",
  setup: async (ctx) => {
    await ctx.model.transform((editor) => {
      const references = new Map<string, Reference>()
      for (const model of editor.list()) {
        if (LOCAL_PROVIDERS.includes(model.providerID)) continue
        const efforts = effortsOf(model)
        const tools = model.capabilities?.tools === true
        const output = typeof model.limit?.output === "number" && model.limit.output > 0 ? model.limit.output : undefined
        if (efforts.length === 0 && !tools) continue
        const reference: Reference = { efforts, tools, output }
        const key = normalize(model.id)
        const current = references.get(key)
        // Preferir la referencia que aporta más niveles de esfuerzo.
        if (!current || current.efforts.length < efforts.length) references.set(key, reference)
      }
      if (references.size === 0) return

      for (const model of editor.list()) {
        if (!LOCAL_PROVIDERS.includes(model.providerID)) continue
        const reference = resolve(references, model.id)
        if (!reference) continue
        editor.update(model.providerID, model.id, (target) => {
          if ((target.variants?.length ?? 0) === 0 && reference.efforts.length > 0) {
            target.variants = reference.efforts.map((id) => ({ id, settings: { reasoningEffort: id } }))
          }
          if (reference.tools) target.capabilities.tools = true
          if (reference.output && reference.output > (target.limit?.output ?? 0)) target.limit.output = reference.output
        })
      }
    })
  },
})
