package com.tetherproxy.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.tetherproxy.app.tunnel.ConnState

@Composable
fun StatusScreen(viewModel: AppViewModel, onGoToSetup: () -> Unit) {
    val status by viewModel.status.collectAsState()
    val egressIp by viewModel.egressIp.collectAsState()

    // The tunnel is "running" for every state except the terminal ones. Start is
    // only tappable when stopped/failed; Stop only when running.
    val running = status.state != ConnState.STOPPED && status.state != ConnState.FAILED

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text("Status")
        HorizontalDivider()
        Text("Connection: ${status.state}")
        Text("Relay: ${status.relayHost ?: "-"}")
        Text("Bytes in:  ${status.bytesIn}")
        Text("Bytes out: ${status.bytesOut}")
        Text("Active streams: ${status.activeStreams}")
        Text("Last error: ${status.lastError ?: "none"}")
        HorizontalDivider()
        Text("Egress self-test (phone's public IP): ${egressIp ?: "not run"}")
        OutlinedButton(
            onClick = { viewModel.runEgressSelfTest() },
            modifier = Modifier.fillMaxWidth()
        ) {
            Text("Run egress IP self-test")
        }
        HorizontalDivider()
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Button(
                onClick = { viewModel.start() },
                enabled = !running,
                modifier = Modifier.weight(1f)
            ) { Text("Start") }
            Button(
                onClick = { viewModel.stop() },
                enabled = running,
                modifier = Modifier.weight(1f)
            ) { Text("Stop") }
        }
        TextButton(onClick = onGoToSetup, modifier = Modifier.fillMaxWidth()) {
            Text("Go to setup")
        }
    }
}
