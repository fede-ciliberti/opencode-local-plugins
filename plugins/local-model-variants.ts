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
 *   - las modalidades de entrada (`capabilities.input`: imagen, audio, video,
 *     pdf) que el modelo base declara,
 *   - `capabilities.temperature`, que habilita los controles de muestreo,
 *   - el precio (`cost`), para que el gasto de la sesión se muestre y sume,
 *   - `limit.output` cuando el modelo base declara uno mayor.
 *
 * Sin las modalidades de entrada OpenCode asume texto solo y reemplaza cada
 * adjunto por `ERROR: Cannot read "<file>" (this model does not support image
 * input)`: el gateway puede publicar `vision: true` y aun así la imagen nunca
 * sale del cliente.
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
  readonly temperature: boolean
  readonly input: readonly string[]
  readonly cost?: readonly any[]
  readonly output?: number
}

const normalize = (id: string) => id.trim().toLowerCase()

/** Modalidades de entrada declaradas por un modelo, sin duplicados ni vacíos. */
function inputOf(model: { capabilities?: { input?: readonly string[] } }): string[] {
  const values: string[] = []
  for (const modality of model.capabilities?.input ?? []) {
    if (typeof modality !== "string" || modality.length === 0) continue
    if (!values.includes(modality)) values.push(modality)
  }
  return values
}

/** Une modalidades conservando el orden recibido y garantizando `text`. */
function mergeInput(current: readonly string[] | undefined, extra: readonly string[]): string[] {
  const values: string[] = ["text"]
  for (const modality of [...(current ?? []), ...extra]) {
    if (typeof modality !== "string" || modality.length === 0) continue
    if (!values.includes(modality)) values.push(modality)
  }
  return values
}

/**
 * Niveles de esfuerzo estándar. Se aceptan como fallback cuando la variante de
 * referencia ajusta el razonamiento con un campo propio de otro paquete (por
 * ejemplo `thinkingConfig` de Google): el id se re-usa como `reasoning_effort`,
 * que es lo que entiende un provider OpenAI-compatible.
 */
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"])

/** Niveles de esfuerzo que declara un modelo de referencia, en orden de aparición. */
function effortsOf(model: { variants?: readonly any[] }): string[] {
  const values: string[] = []
  for (const variant of model.variants ?? []) {
    const effort =
      typeof variant?.settings?.reasoningEffort === "string"
        ? variant.settings.reasoningEffort
        : typeof variant?.body?.reasoning_effort === "string"
          ? variant.body.reasoning_effort
          : typeof variant?.id === "string" && EFFORTS.has(variant.id.toLowerCase())
            ? variant.id
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
        const temperature = model.capabilities?.temperature === true
        const input = inputOf(model)
        const cost = Array.isArray(model.cost) && model.cost.length > 0 ? model.cost : undefined
        const output = typeof model.limit?.output === "number" && model.limit.output > 0 ? model.limit.output : undefined
        const richerInput = input.some((modality) => modality !== "text")
        if (efforts.length === 0 && !tools && !richerInput && !cost) continue
        const reference: Reference = { efforts, tools, temperature, input, cost, output }
        const key = normalize(model.id)
        const current = references.get(key)
        if (!current) {
          references.set(key, reference)
          continue
        }
        // Preferir la referencia que aporta más niveles de esfuerzo, sin perder
        // modalidades ni tools que sólo declare otra de las referencias. El
        // precio lo aporta el primer provider que lo publique.
        references.set(key, {
          efforts: current.efforts.length >= efforts.length ? current.efforts : efforts,
          tools: current.tools || tools,
          temperature: current.temperature || temperature,
          input: mergeInput(current.input, input),
          cost: current.cost ?? cost,
          output: current.output !== undefined && (output === undefined || current.output >= output) ? current.output : output,
        })
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
          if (reference.temperature) target.capabilities.temperature = true
          const input = mergeInput(target.capabilities.input, reference.input)
          if (input.length > (target.capabilities.input?.length ?? 0)) target.capabilities.input = input
          if ((target.cost?.length ?? 0) === 0 && reference.cost?.length) target.cost = [...reference.cost]
          if (reference.output && reference.output > (target.limit?.output ?? 0)) target.limit.output = reference.output
        })
      }
    })
  },
})
