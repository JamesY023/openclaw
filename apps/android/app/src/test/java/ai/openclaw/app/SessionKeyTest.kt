package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayEndpoint
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SessionKeyTest {
  @Test
  fun configuredDefaultMatchesOnlyItsGatewayAndAgent() {
    val key = "agent:jessica:node-d4d8d337f8c4"
    val endpoint = GatewayEndpoint.manual("QUEEN.example", 443, true, "/gateway")
    for (deviceId in listOf("phone1234567890", "tablet1234567890")) {
      assertEquals(key, buildNodeMainSessionKey(deviceId, "jessica", key, "wss://queen.example/gateway", endpoint))
      assertEquals(key, buildNodeMainSessionKey(deviceId, " jessica ", key, "wss://queen.example:443/gateway", endpoint))
      for (other in listOf(null, endpoint.copy(host = "other.example"), endpoint.copy(port = 8443), endpoint.copy(tlsEnabled = false), endpoint.copy(contextPath = "/other"))) {
        assertEquals("agent:jessica:node-${deviceId.take(12)}", buildNodeMainSessionKey(deviceId, "jessica", key, "wss://queen.example/gateway", other))
      }
      assertEquals("agent:scout:node-${deviceId.take(12)}", buildNodeMainSessionKey(deviceId, "scout", key, "wss://queen.example/gateway", endpoint))
      assertEquals("agent:main:node-${deviceId.take(12)}", buildNodeMainSessionKey(deviceId, null, key, "wss://queen.example/gateway", endpoint))
      assertEquals("agent:jessica:node-${deviceId.take(12)}", buildNodeMainSessionKey(deviceId, "jessica", gateway = endpoint))
    }
    assertEquals(key, buildNodeMainSessionKey("tablet", "jessica", key, "wss://queen.example/", endpoint.copy(contextPath = "")))
    assertEquals(key, buildNodeMainSessionKey("tablet", "jessica", key, "ws://queen.example", endpoint.copy(port = 80, tlsEnabled = false, contextPath = "")))
  }

  @Test
  fun buildNodeMainSessionKeyUsesStableDeviceScopedSuffix() {
    val key = buildNodeMainSessionKey(deviceId = "1234567890abcdef", agentId = "ops")

    assertEquals("agent:ops:node-1234567890ab", key)
  }

  @Test
  fun buildAndroidAppSessionLabelIncludesDeviceDisplayName() {
    assertEquals("OpenClaw App · 1234567890ab", buildAndroidAppSessionLabel(null, "1234567890abcdef"))
    assertEquals(
      "OpenClaw App · Pixel · 1234567890ab",
      buildAndroidAppSessionLabel(" Pixel ", "1234567890abcdef"),
    )
  }

  @Test
  fun buildAndroidAppSessionLabelPreservesUtf16BoundariesAtDisplayNameLimit() {
    val deviceId = "1234567890abcdef"
    val splitPairPrefix = "a".repeat(95)
    assertEquals(
      "OpenClaw App · $splitPairPrefix · 1234567890ab",
      buildAndroidAppSessionLabel("$splitPairPrefix😀tail", deviceId),
    )

    val completePairPrefix = "a".repeat(94)
    assertEquals(
      "OpenClaw App · $completePairPrefix😀 · 1234567890ab",
      buildAndroidAppSessionLabel("$completePairPrefix😀tail", deviceId),
    )
  }

  @Test
  fun resolveAgentIdFromMainSessionKeyParsesCanonicalAgentKey() {
    assertEquals("ops", resolveAgentIdFromMainSessionKey("agent:ops:main"))
    assertNull(resolveAgentIdFromMainSessionKey("global"))
  }
}
