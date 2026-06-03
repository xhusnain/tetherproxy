package com.tetherproxy.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Divider
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable
fun StatusScreen(viewModel: AppViewModel, onGoToSetup: () -> Unit) {
    val status by viewModel.status.collectAsState()
    val egressIp by viewModel.egressIp.collectAsState()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text("Status")
        Divider()
        Text("Connection: ${status.state}")
        Text("Relay: ${status.relayHost ?: "-"}")
        Text("Bytes in:  ${status.bytesIn}")
        Text("Bytes out: ${status.bytesOut}")
        Text("Active streams: ${status.activeStreams}")
        Text("Last error: ${status.lastError ?: "none"}")
        Divider()
        Text("Egress self-test (phone's public IP): ${egressIp ?: "not run"}")
        OutlinedButton(
            onClick = { viewModel.runEgressSelfTest() },
            modifier = Modifier.fillMaxWidth()
        ) {
            Text("Run egress IP self-test")
        }
        Divider()
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Button(
                onClick = { viewModel.start() },
                modifier = Modifier.weight(1f)
            ) { Text("Start") }
            Button(
                onClick = { viewModel.stop() },
                modifier = Modifier.weight(1f)
            ) { Text("Stop") }
        }
        TextButton(onClick = onGoToSetup, modifier = Modifier.fillMaxWidth()) {
            Text("Go to setup")
        }
    }
}
