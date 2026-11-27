import { readRelaySettingsGlobally } from "@cline/core"
import { EmptyRequest } from "@shared/proto/cline/common"
import type { RelaySettings } from "@shared/proto/cline/remote_control"
import { describeRelaySettings } from "../../relay/relaySettingsView"
import type { Controller } from ".."

export async function getRelaySettings(_controller: Controller, _request: EmptyRequest): Promise<RelaySettings> {
	return describeRelaySettings(readRelaySettingsGlobally())
}
