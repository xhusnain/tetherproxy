package com.tetherproxy.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.text.KeyboardOptions

@Composable
fun SetupScreen(viewModel: AppViewModel, onGoToStatus: () -> Unit) {
    val form by viewModel.form.collectAsState()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text("Relay setup")

        OutlinedTextField(
            value = form.relayHost,
            onValueChange = { v -> viewModel.update { it.copy(relayHost = v) } },
            label = { Text("Relay host / IP") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth()
        )
        OutlinedTextField(
            value = form.tunnelPort,
            onValueChange = { v -> viewModel.update { it.copy(tunnelPort = v) } },
            label = { Text("Tunnel port (WSS)") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier.fillMaxWidth()
        )
        OutlinedTextField(
            value = form.proxyPort,
            onValueChange = { v -> viewModel.update { it.copy(proxyPort = v) } },
            label = { Text("Proxy port") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier.fillMaxWidth()
        )
        OutlinedTextField(
            value = form.proxyTlsPort,
            onValueChange = { v -> viewModel.update { it.copy(proxyTlsPort = v) } },
            label = { Text("Proxy TLS port (optional)") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier.fillMaxWidth()
        )
        OutlinedTextField(
            value = form.pairingToken,
            onValueChange = { v -> viewModel.update { it.copy(pairingToken = v) } },
            label = { Text("Pairing token") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth()
        )
        OutlinedTextField(
            value = form.proxyUsername,
            onValueChange = { v -> viewModel.update { it.copy(proxyUsername = v) } },
            label = { Text("Proxy username") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth()
        )
        OutlinedTextField(
            value = form.proxyPassword,
            onValueChange = { v -> viewModel.update { it.copy(proxyPassword = v) } },
            label = { Text("Proxy password") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            trailingIcon = {
                // Spec §4.2/§8: suggest a strong random password.
                TextButton(onClick = { viewModel.generatePassword() }) {
                    Text("Generate")
                }
            },
            modifier = Modifier.fillMaxWidth()
        )
        OutlinedTextField(
            value = form.pinnedFingerprint,
            onValueChange = { v -> viewModel.update { it.copy(pinnedFingerprint = v) } },
            label = { Text("Pinned cert SHA-256 (blank = trust on first use)") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth()
        )
        Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            Switch(
                checked = form.autoStartOnBoot,
                onCheckedChange = { v -> viewModel.update { it.copy(autoStartOnBoot = v) } }
            )
            Text("  Auto-start on boot")
        }

        Button(
            onClick = {
                viewModel.saveAndConnect()
                onGoToStatus()
            },
            modifier = Modifier.fillMaxWidth()
        ) {
            Text("Save & Connect")
        }
        TextButton(onClick = onGoToStatus, modifier = Modifier.fillMaxWidth()) {
            Text("Go to status")
        }
    }
}
