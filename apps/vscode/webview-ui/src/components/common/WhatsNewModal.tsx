import React from "react"
import Markdown from "react-markdown"
import { Dialog, DialogContent } from "@/components/ui/dialog"

interface WhatsNewModalProps {
	open: boolean
	onClose: () => void
	version: string
	/** The fork's CHANGELOG entry for the running version, as markdown — shipped in the package. */
	notes: string
}

/**
 * Cline Cubed: the What's New modal, opened on the chat home after a version change. It shows the
 * fork's own notes for the running version and nothing else. Stock rendered banners fetched from
 * Cline's server here, with a row of Cline's community links beneath them; neither is the fork's,
 * so neither appears.
 */
const WhatsNewModal: React.FC<WhatsNewModalProps> = ({ open, onClose, version, notes }) => {
	const inlineCodeStyle: React.CSSProperties = {
		backgroundColor: "var(--vscode-textCodeBlock-background)",
		padding: "2px 6px",
		borderRadius: "3px",
		fontFamily: "var(--vscode-editor-font-family)",
		fontSize: "0.9em",
	}

	// The window opens on its own after an update, while the person may be working in another panel
	// (another extension's chat, an editor). So it never takes focus: it does not trap focus as a
	// modal dialog would — a trap pulled focus back into this chat each time the chat's state was
	// redrawn — and it moves no focus when it opens or closes. It still shows over the chat, with its
	// own dimmed backdrop (Radix draws its backdrop only for a modal dialog), and still closes with its
	// X, Escape, or a click outside it.
	return (
		<Dialog modal={false} onOpenChange={(isOpen) => !isOpen && onClose()} open={open}>
			{open && <div aria-hidden="true" className="fixed inset-0 z-50 bg-black/80" data-testid="whats-new-backdrop" />}
			<DialogContent
				aria-describedby="whats-new-description"
				aria-labelledby="whats-new-title"
				className="pt-5 px-5 pb-4 gap-0"
				onCloseAutoFocus={(event) => event.preventDefault()}
				onOpenAutoFocus={(event) => event.preventDefault()}>
				<div id="whats-new-description">
					<h2
						className="text-lg font-semibold mb-3 pr-6"
						id="whats-new-title"
						style={{ color: "var(--vscode-editor-foreground)" }}>
						New in Cline Cubed {version}
					</h2>

					<div
						className="text-sm max-h-[60vh] overflow-y-auto"
						style={{ color: "var(--vscode-descriptionForeground)" }}>
						<Markdown
							components={{
								a: ({ href, children }) => (
									<a
										href={href}
										rel="noopener noreferrer"
										style={{ color: "var(--vscode-textLink-foreground)" }}
										target="_blank">
										{children}
									</a>
								),
								code: ({ children }) => <code style={inlineCodeStyle}>{children}</code>,
								h3: ({ children }) => (
									<h3
										className="text-sm font-semibold mt-3 mb-1"
										style={{ color: "var(--vscode-editor-foreground)" }}>
										{children}
									</h3>
								),
								li: ({ children }) => <li className="mb-2">{children}</li>,
								ul: ({ children }) => <ul className="pl-4 list-disc">{children}</ul>,
							}}>
							{notes}
						</Markdown>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	)
}

export default WhatsNewModal
