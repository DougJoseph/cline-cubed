export interface WebviewMessage {
	type:
		| "grpc_request"
		| "grpc_request_cancel"
		| "dismissOnboarding"
		// Cline Cubed: a chat surface reports which session it now shows, so the host delivers
		// that session's state and transcript to it alone.
		| "bindSurfaceSession"
		// Cline Cubed: the chats list asks the host to open an existing chat — revealed where it
		// already lives, or opened in the configured location if it is not open anywhere.
		| "openSession"
		// Cline Cubed: a CHAT surface asks the host to open an existing chat from its own
		// history/recent list. Already open on another surface → that surface is revealed and
		// NOTHING moves (accidentally reopening a chat must never evict it from where it lives).
		// Not open anywhere → it opens in the ASKING surface, which the host binds and then
		// answers with "bindTaskToSurface" so the webview adopts and navigates.
		| "openSessionHere"
		// Cline Cubed: the chats list's New Chat button, routed through the same
		// openOrCreateChat every chat button uses.
		| "newChatFromList"
	grpc_request?: GrpcRequest
	grpc_request_cancel?: GrpcCancel
	/** Cline Cubed: session carried by "bindSurfaceSession" (null = a new chat, no session yet). */
	sessionId?: string | null
}

export type GrpcRequest = {
	service: string
	method: string
	message: any // JSON serialized protobuf message
	request_id: string // For correlating requests and responses
	is_streaming: boolean // Whether this is a streaming request
}

export type GrpcCancel = {
	request_id: string // ID of the request to cancel
}

export type ClineAskResponse = "yesButtonClicked" | "noButtonClicked" | "messageResponse"

export type ClineCheckpointRestore = "task" | "workspace" | "taskAndWorkspace"

export type TaskFeedbackType = "thumbs_up" | "thumbs_down"
