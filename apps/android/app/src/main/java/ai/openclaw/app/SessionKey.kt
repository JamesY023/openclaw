package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.normalizeGatewayContextPath
import java.net.URI

/** Normalizes blank gateway session keys to the legacy main session alias. */
internal fun normalizeMainKey(raw: String?): String {
  val trimmed = raw?.trim()
  return if (!trimmed.isNullOrEmpty()) trimmed else "main"
}

/** Extracts the agent id from canonical agent-scoped main session keys. */
internal fun resolveAgentIdFromMainSessionKey(raw: String?): String? {
  val trimmed = raw?.trim().orEmpty()
  if (!trimmed.startsWith("agent:")) return null
  return trimmed
    .removePrefix("agent:")
    .substringBefore(':')
    .trim()
    .ifEmpty { null }
}

/** Uses a configured gateway/agent default, otherwise retaining the device session. */
internal fun buildNodeMainSessionKey(
  deviceId: String,
  agentId: String?,
  defaultSessionKey: String = "",
  defaultSessionGatewayUrl: String = "",
  gateway: GatewayEndpoint? = null,
): String {
  val resolvedAgentId = agentId?.trim().orEmpty().ifEmpty { "main" }
  val configuredGateway = runCatching { URI(defaultSessionGatewayUrl) }.getOrNull()
  if (
    gateway != null &&
      defaultSessionKey.startsWith("agent:$resolvedAgentId:") &&
      configuredGateway?.scheme in setOf("ws", "wss") &&
      configuredGateway?.host.equals(gateway.host, ignoreCase = true) &&
      (configuredGateway?.scheme == "wss") == gateway.tlsEnabled &&
      (configuredGateway?.port?.takeIf { it != -1 } ?: if (gateway.tlsEnabled) 443 else 80) == gateway.port &&
      normalizeGatewayContextPath(configuredGateway?.rawPath) == normalizeGatewayContextPath(gateway.contextPath)
  ) {
    return defaultSessionKey
  }
  return "agent:$resolvedAgentId:node-${deviceId.take(12)}"
}

/** Human-readable, device-unique label applied when Android creates or adopts its session. */
internal fun buildAndroidAppSessionLabel(
  displayName: String?,
  deviceId: String,
): String {
  val deviceSuffix = deviceId.take(12)
  val displaySuffix = displayName?.trim()?.takeUtf16Safe(96)?.takeIf { it.isNotEmpty() }
  return listOfNotNull("OpenClaw App", displaySuffix, deviceSuffix).joinToString(" · ")
}
