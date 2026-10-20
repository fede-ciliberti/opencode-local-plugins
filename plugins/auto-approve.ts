// Auto-aprueba toda evaluación de permisos que resolvería a "ask".
//
// Motivo: los agentes definidos por plugins (sisyphus, explore, atlas, ...) declaran
// una lista de permisos sin comodín final, así que cualquier acción que no enumeran
// (external_directory, websearch, skill, subagent, tools MCP, execute, ...) cae en el
// default "ask". En el TUI ese "ask" solo se responde solo cuando la pestaña tiene
// foco (session.permissions = "autoaccept" se aplica en la ruta montada), así que una
// sesión en background queda colgada indefinidamente.
//
// Este hook corre en el server, no en el cliente: no depende del foco.
// Un "deny" configurado explícitamente es final y NO pasa por el hook, así que sigue
// siendo el kill-switch.
export default {
  id: "local.auto-approve",
  async setup(ctx: any) {
    await ctx.permission.hook("evaluate", (event: any) => {
      if (event.effect === "ask") event.effect = "allow"
    })
  },
}
